// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off - role.md and the token are plain files; times are stored as ISO text.
/**
 * Bots: create one, talk to it, and run its turns. A turn starts when the user writes, a routine
 * comes due, or one of its threads needs it; it runs in the bot's one work thread and acts through
 * the `t3bot` tools.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  RunId,
  RuntimeMode,
  ThreadId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { resolveRuntimeMode } from "../../mcp/delegatedTaskModes.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { channelAccess, type ChannelView } from "../channels/hub.ts";
import { InboxRuntime } from "../inbox/InboxRuntime.ts";
import { firstProviderDefault, ForkHttpError } from "../inbox/operations.ts";
import { BotRuntime, type BotRuntimeShape } from "./BotRuntime.ts";
import { buildPacket, RECENT_CHAT_LIMIT, type Notebook } from "./packet.ts";
import { nextDueAt } from "./routines.ts";
import { listSkills, ownSkillsPath, sharedSkillsPath } from "./skills.ts";
import {
  channelSettings,
  type Bot,
  type BotSettings,
  type ChannelSettings,
  type ChatMessage,
} from "./store.ts";

/** Chat shown on the Bots page; older messages stay in the store. */
const CHAT_PAGE = 200;
const NAME_CHARS = 60;
const MESSAGE_CHARS = 20_000;
export const ROLE_CHARS = 20_000;
const SET_ASIDE_AFTER_DAYS = 14;
/** A routine starting this much after its time tells the bot both times. */
const LATE_MS = 15 * 60_000;

const TERMINAL: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export const isTerminalRunStatus = (status: string) =>
  TERMINAL.has(status as OrchestrationV2RunStatus);

/** The environment's chat channels; none when it has no inbox or the user configured none. */
export const configuredChannels = Effect.fn("ForkBot.configuredChannels")(function* () {
  const inbox = yield* Effect.serviceOption(InboxRuntime);
  if (Option.isNone(inbox)) return [] as ReadonlyArray<ChannelView>;
  return inbox.value.hub.list().filter((channel) => channel.enabled);
});

/** Those a bot can read now. */
export const readableChannels = Effect.fn("ForkBot.readableChannels")(function* () {
  return (yield* configuredChannels()).filter((channel) => channelAccess(channel.status).read);
});

export const channelName = (channel: ChannelView) => channel.config?.displayName ?? channel.name;

/** The channels a bot may use: none while its Channels switch is off. */
const botChannels = Effect.fn("ForkBot.botChannels")(function* (bot: Bot) {
  if (!bot.settings.channelsEnabled) return [];
  return (yield* configuredChannels()).map((channel) => ({
    id: channel.id,
    name: channelName(channel),
    ...channelSettings(bot.settings, channel.id),
  }));
});

const badRequest = (detail: string, field?: string) =>
  new ForkHttpError({ status: 400, code: "bad_request", detail, ...(field ? { field } : {}) });

const notFound = () =>
  new ForkHttpError({ status: 404, code: "not_found", detail: "That bot does not exist." });

const internal = (cause: unknown) =>
  new ForkHttpError({
    status: 500,
    code: "internal",
    detail: cause instanceof Error ? cause.message : String(cause),
  });

export const nowIso = () => new Date().toISOString();
export const newId = (prefix: string) => `${prefix}_${NodeCrypto.randomUUID()}`;
const localDay = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
const localTime = (at: Date) =>
  `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

export const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => badRequest("The request is not valid.")),
  );

export const rolePath = (botsDir: string, botId: string) =>
  NodePath.join(botsDir, botId, "role.md");
/** The bot's own folder: its work thread runs here, and it keeps longer notes in `notes/`. */
const workspacePath = (botsDir: string, botId: string) =>
  NodePath.join(botsDir, botId, "workspace");
const notesPath = (botsDir: string, botId: string) =>
  NodePath.join(workspacePath(botsDir, botId), "notes");
const NOTES_LISTED = 50;

export interface NoteFile {
  readonly name: string;
  readonly bytes: number;
  readonly updatedAt: string;
}

/** The files in the bot's notes folder, newest first. */
const listNotes = (botsDir: string, botId: string) =>
  Effect.promise(async (): Promise<ReadonlyArray<NoteFile>> => {
    const dir = notesPath(botsDir, botId);
    const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const stat = await NodeFSP.stat(NodePath.join(dir, entry.name));
          return { name: entry.name, bytes: stat.size, updatedAt: stat.mtime.toISOString() };
        }),
    );
    return files
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, NOTES_LISTED);
  });

const ensureWorkspace = async (botsDir: string, botId: string) => {
  await NodeFSP.mkdir(notesPath(botsDir, botId), { recursive: true });
  await NodeFSP.mkdir(ownSkillsPath(botsDir, botId), { recursive: true });
  await NodeFSP.mkdir(sharedSkillsPath(botsDir), { recursive: true });
};
export const tokenPath = (botsDir: string, botId: string) => NodePath.join(botsDir, botId, "token");

/** Each bot's tool token; written once, kept until the bot is deleted. */
const writeToken = (botsDir: string, botId: string) =>
  NodeFSP.writeFile(tokenPath(botsDir, botId), NodeCrypto.randomBytes(32).toString("hex"), {
    mode: 0o600,
    flag: "wx",
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });

export const readRole = (botsDir: string, botId: string) =>
  Effect.promise(() => NodeFSP.readFile(rolePath(botsDir, botId), "utf8").catch(() => ""));

const requireBot = Effect.fn("ForkBot.requireBot")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const bot = runtime.existingStore()?.getBot(botId) ?? null;
  if (bot === null) return yield* notFound();
  return bot;
});

/** The bot's notebook with its threads' current titles. */
export const readNotebook = Effect.fn("ForkBot.readNotebook")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = runtime.store();
  const owned = store.listThreads(botId);
  const titles = yield* threads
    .getThreadTitles(owned.map((thread) => ThreadId.make(thread.threadId)))
    .pipe(Effect.orElseSucceed((): Record<ThreadId, string> => ({})));
  return {
    items: store.listItems(botId),
    threads: owned.map((thread) => ({
      ...thread,
      title: titles[ThreadId.make(thread.threadId)] ?? null,
    })),
    routines: store.listRoutines(botId),
    memory: store.listMemory(botId),
  } satisfies Notebook;
});

export interface BotSummary {
  readonly id: string;
  readonly name: string;
  readonly modelSelection: Bot["modelSelection"];
  readonly working: boolean;
  readonly paused: boolean;
  readonly lastMessage: Pick<ChatMessage, "role" | "text" | "createdAt"> | null;
  /** Its posts since the user last looked, plus its questions still waiting for an answer. */
  readonly unread: number;
}

export const listBots = Effect.fn("ForkBot.listBots")(function* () {
  const store = (yield* BotRuntime).existingStore();
  const bots: ReadonlyArray<BotSummary> = (store?.listBots() ?? []).map((bot) => {
    const last = store!.recentChat(bot.id, 1)[0];
    return {
      id: bot.id,
      name: bot.name,
      modelSelection: bot.modelSelection,
      working: store!.getTurn(bot.id) !== null,
      paused: bot.paused,
      lastMessage: last ? { role: last.role, text: last.text, createdAt: last.createdAt } : null,
      unread: store!.unseenCount(bot.id) + store!.openQuestions(bot.id).length,
    };
  });
  return { bots };
});

export const readBot = Effect.fn("ForkBot.readBot")(function* (params: URLSearchParams) {
  const runtime = yield* BotRuntime;
  const bot = yield* requireBot(params.get("botId") ?? "");
  const store = runtime.store();
  return {
    // A count from an earlier day is spent: today starts at zero.
    bot: { ...bot, turnsToday: bot.lastTurnDay === localDay(new Date()) ? bot.turnsToday : 0 },
    role: yield* readRole(runtime.botsDir, bot.id),
    working: store.getTurn(bot.id) !== null,
    chat: store.recentChat(bot.id, CHAT_PAGE),
    notebook: yield* readNotebook(bot.id),
    questions: store.openQuestions(bot.id),
    notesPath: notesPath(runtime.botsDir, bot.id),
    notes: yield* listNotes(runtime.botsDir, bot.id),
    skills: yield* Effect.promise(() => listSkills(runtime.botsDir, bot.id)),
    // For its settings: each channel, and which bot wakes on the user's mentions there.
    channels: (yield* configuredChannels()).map((channel) => {
      const mentionBot = store
        .listBots()
        .find(
          (other) =>
            other.settings.channelsEnabled && channelSettings(other.settings, channel.id).mentions,
        );
      return {
        id: channel.id,
        name: channelName(channel),
        mentionBot: mentionBot ? { id: mentionBot.id, name: mentionBot.name } : null,
      };
    }),
  };
});

const NoteInput = Schema.Struct({
  botId: Schema.String,
  name: Schema.String,
  kind: Schema.optional(Schema.Literals(["note", "skill", "shared-skill"])),
});

/** A note, or a skill's SKILL.md by its folder name, for the Bots page to show. */
export const readNote = Effect.fn("ForkBot.readNote")(function* (params: URLSearchParams) {
  const runtime = yield* BotRuntime;
  const input = yield* decode(NoteInput, Object.fromEntries(params));
  const bot = yield* requireBot(input.botId);
  if (NodePath.basename(input.name) !== input.name || input.name.startsWith(".")) {
    return yield* badRequest("Name a file in the bot's folder.", "name");
  }
  const base =
    input.kind === "skill"
      ? ownSkillsPath(runtime.botsDir, bot.id)
      : input.kind === "shared-skill"
        ? sharedSkillsPath(runtime.botsDir)
        : notesPath(runtime.botsDir, bot.id);
  const filePath =
    input.kind === undefined || input.kind === "note"
      ? NodePath.join(base, input.name)
      : NodePath.join(base, input.name, "SKILL.md");
  // The bot writes these folders, so a symlink in them must not reach past them.
  const text = yield* Effect.promise(async () => {
    try {
      const [root, real] = await Promise.all([NodeFSP.realpath(base), NodeFSP.realpath(filePath)]);
      if (!real.startsWith(root + NodePath.sep)) return null;
      return await NodeFSP.readFile(real, "utf8");
    } catch {
      return null;
    }
  });
  if (text === null) {
    return yield* new ForkHttpError({ status: 404, code: "not_found", detail: "No such note." });
  }
  return { name: input.name, text: text.slice(0, NOTE_CHARS) };
});

const NOTE_CHARS = 200_000;

const CreateInput = Schema.Struct({
  name: Schema.String,
  modelSelection: Schema.optional(Schema.NullOr(Schema.Unknown)),
  runtimeMode: Schema.optional(RuntimeMode),
});

export const createBot = Effect.fn("ForkBot.createBot")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(CreateInput, input);
  const name = decoded.name.trim();
  if (name === "" || name.length > NAME_CHARS) {
    return yield* badRequest(`Name the bot in 1 to ${NAME_CHARS} characters.`, "name");
  }
  // No pick means the model the picker shows first: the first ready provider's default.
  const picked =
    decoded.modelSelection === undefined || decoded.modelSelection === null
      ? firstProviderDefault(yield* (yield* ProviderRegistry.ProviderRegistry).getProviders)
      : decoded.modelSelection;
  const modelSelection = yield* decode(ModelSelection, picked).pipe(
    Effect.mapError(() => badRequest("Choose a model.", "modelSelection")),
  );
  // Its work thread lives in the scratch project; refuse now rather than on the first message.
  yield* (yield* ManagedProjectFolders).ensureScratchProject.pipe(
    Effect.mapError(
      () =>
        new ForkHttpError({
          status: 409,
          code: "scratch_unavailable",
          detail:
            "Bots need the No project folder, which is unavailable when T3's data directory is inside a Git checkout.",
        }),
    ),
  );
  const id = newId("bot");
  yield* Effect.tryPromise({
    try: async () => {
      await ensureWorkspace(runtime.botsDir, id);
      await writeToken(runtime.botsDir, id);
    },
    catch: internal,
  });
  runtime
    .store()
    .createBot(
      { id, name, modelSelection, createdAt: nowIso() },
      decoded.runtimeMode ?? (yield* runtimeModeFor(modelSelection, "auto")),
    );
  yield* runtime.active.open;
  runtime.publish(id);
  return { botId: id };
});

const RoleInput = Schema.Struct({ botId: Schema.String, role: Schema.String });

export const saveRole = Effect.fn("ForkBot.saveRole")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(RoleInput, input);
  const bot = yield* requireBot(decoded.botId);
  if (decoded.role.length > ROLE_CHARS) {
    return yield* badRequest(`Keep the role under ${ROLE_CHARS} characters.`, "role");
  }
  yield* Effect.tryPromise({
    try: () => NodeFSP.writeFile(rolePath(runtime.botsDir, bot.id), decoded.role),
    catch: internal,
  });
  runtime.store().enqueue(bot.id, "The user edited your role.", false, nowIso());
  runtime.publish(bot.id);
  return {};
});

const BotIdInput = Schema.Struct({ botId: Schema.String });

/** Its threads stay as ordinary threads; only the bot and its notebook go. */
export const deleteBot = Effect.fn("ForkBot.deleteBot")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const bot = yield* requireBot((yield* decode(BotIdInput, input)).botId);
  yield* runtime.turnLock.withPermit(
    Effect.sync(() => {
      runtime.store().deleteBot(bot.id);
      if (bot.workThreadId !== null) runtime.workThreads.delete(bot.workThreadId);
      for (const [threadId, owner] of runtime.ownedThreads) {
        if (owner === bot.id) runtime.ownedThreads.delete(threadId);
      }
    }),
  );
  yield* Effect.promise(() =>
    NodeFSP.rm(NodePath.join(runtime.botsDir, bot.id), { recursive: true, force: true }),
  );
  runtime.publish(bot.id);
  return {};
});

const MessageInput = Schema.Struct({ botId: Schema.String, text: Schema.String });

export const sendMessage = Effect.fn("ForkBot.sendMessage")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(MessageInput, input);
  const bot = yield* requireBot(decoded.botId);
  const text = decoded.text.trim();
  if (text === "" || text.length > MESSAGE_CHARS) {
    return yield* badRequest(`Write 1 to ${MESSAGE_CHARS} characters.`, "text");
  }
  const messageId = newId("msg");
  runtime
    .store()
    .addChat({ id: messageId, botId: bot.id, role: "user", text, createdAt: nowIso() });
  runtime.publish(bot.id);
  if (!(yield* steer(bot, messageId, text))) yield* wake(bot.id);
  return { messageId };
});

/** A message that arrives mid-turn joins that turn; false when there is none to join. */
const steer = Effect.fn("ForkBot.steer")(function* (bot: Bot, messageId: string, text: string) {
  const runtime = yield* BotRuntime;
  const threads = yield* ThreadManagement.ThreadManagementService;
  return yield* runtime.turnLock.withPermit(
    Effect.gen(function* () {
      const store = runtime.store();
      const turn = store.getTurn(bot.id);
      if (turn === null || bot.workProjectId === null) return false;
      const sent = yield* Effect.result(
        threads.sendToThread({
          projectId: ProjectId.make(bot.workProjectId),
          commandId: CommandId.make(newId("fork-bot")),
          threadId: ThreadId.make(turn.threadId),
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          text: `The user, while you work:\n${text}`,
          attachments: [],
          mode: "steer",
          createdBy: "system",
          creationSource: "server",
        }),
      );
      if (Result.isFailure(sent) || sent.success.delivery !== "steered") return false;
      store.markAnswered(bot.id, turn.runId, [messageId]);
      runtime.publish(bot.id);
      return true;
    }),
  );
});

export const postError = Effect.fn("ForkBot.postError")(function* (botId: string, text: string) {
  const runtime = yield* BotRuntime;
  runtime.store().addChat({ id: newId("msg"), botId, role: "error", text, createdAt: nowIso() });
  runtime.publish(botId);
});

/** The bot's chosen mode, or the broadest narrower one its provider offers. */
export const runtimeModeFor = Effect.fn("ForkBot.runtimeModeFor")(function* (
  modelSelection: ModelSelection,
  wanted: RuntimeMode,
) {
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  return yield* resolveRuntimeMode(wanted, undefined, {
    modelSelection,
    supportedRuntimeModes: providers.find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    )?.supportedRuntimeModes,
  }).pipe(Effect.orElseSucceed(() => wanted));
});

/** Sends the packet as a new turn: launches the work thread on the first one. */
const dispatch = Effect.fn("ForkBot.dispatch")(function* (
  bot: Bot,
  packet: string,
  freshContext: boolean,
) {
  const runtime = yield* BotRuntime;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const commandId = CommandId.make(newId("fork-bot"));
  const messageId = MessageId.make(NodeCrypto.randomUUID());
  const modelSelection = bot.modelSelection;
  if (bot.workThreadId !== null && bot.workProjectId !== null) {
    const sent = yield* threads.sendToThread({
      projectId: ProjectId.make(bot.workProjectId),
      commandId,
      threadId: ThreadId.make(bot.workThreadId),
      messageId,
      text: packet,
      attachments: [],
      modelSelection,
      mode: "queue",
      ...(freshContext ? { freshContext: true } : {}),
      createdBy: "system",
      creationSource: "server",
    });
    return { threadId: bot.workThreadId, runId: sent.run.id };
  }
  const { projectId } = yield* (yield* ManagedProjectFolders).ensureScratchProject;
  const launched = yield* ThreadMessageIntake.launchThread({
    commandId,
    threadId: ThreadId.make(commandId),
    projectId,
    title: `${bot.name} (bot)`,
    modelSelection,
    runtimeMode: yield* runtimeModeFor(modelSelection, bot.settings.runtimeMode),
    interactionMode: "default",
    workspaceStrategy: {
      type: "existing_worktree",
      worktreePath: workspacePath(runtime.botsDir, bot.id),
    },
    initialMessage: { messageId, text: packet, attachments: [] },
    createdBy: "system",
    creationSource: "server",
  });
  const run = launched.projection.runs.find((candidate) => candidate.userMessageId === messageId);
  if (run === undefined) return yield* internal("The work thread started no run.");
  runtime.store().setWorkThread(bot.id, launched.threadId, projectId);
  runtime.workThreads.set(launched.threadId, bot.id);
  return { threadId: launched.threadId, runId: run.id };
});

/** Quotes a word for a POSIX shell; the state folder may hold spaces (`Application Support`). */
export const shellQuote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const toolCommand = (runtime: BotRuntimeShape, botId: string) =>
  `${shellQuote(runtime.cliPath)} --bot ${shellQuote(botId)}`;

/** Starts a turn when the user wrote or something that wakes the bot is queued, unless one runs. */
const wake = Effect.fn("ForkBot.wake")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const failure = yield* runtime.turnLock.withPermit(
    Effect.gen(function* () {
      const store = runtime.store();
      const bot = store.getBot(botId);
      if (bot === null || bot.paused || store.getTurn(botId) !== null) return null;
      const waiting = store.waitingMessages(botId);
      const queued = store.queued(botId);
      if (waiting.length === 0 && !queued.some((event) => event.wakes)) return null;
      const now = new Date();
      const today = localDay(now);
      const firstTurnToday = bot.lastTurnDay !== today;
      const turnsToday = firstTurnToday ? 0 : bot.turnsToday;
      if (turnsToday >= bot.settings.turnsPerDay) {
        return store.noteBudgetSpent(botId, today)
          ? `${bot.name} used its ${bot.settings.turnsPerDay} turns for today. What happens meanwhile waits for tomorrow, or raise its budget.`
          : null;
      }
      yield* runtime.ensureCli;
      yield* Effect.promise(async () => {
        await writeToken(runtime.botsDir, botId);
        await ensureWorkspace(runtime.botsDir, botId);
      });
      const answered = store
        .recentChat(botId, RECENT_CHAT_LIMIT + waiting.length)
        .filter((message) => !waiting.some((candidate) => candidate.id === message.id));
      // A new day starts a fresh provider session; the full packet carries all a turn needs.
      const freshContext = firstTurnToday && bot.lastTurnDay !== null;
      const seen =
        freshContext || bot.workThreadId === null
          ? null
          : store.seenPacket(botId, bot.modelSelection);
      const packet = buildPacket(
        {
          name: bot.name,
          role: yield* readRole(runtime.botsDir, botId),
          tool: toolCommand(runtime, botId),
          notebook: yield* readNotebook(botId),
          notesPath: notesPath(runtime.botsDir, botId),
          notes: yield* listNotes(runtime.botsDir, botId),
          skillsPath: ownSkillsPath(runtime.botsDir, botId),
          sharedSkillsPath: sharedSkillsPath(runtime.botsDir),
          skills: yield* Effect.promise(() => listSkills(runtime.botsDir, botId)),
          questions: store.openQuestions(botId),
          recentChat: answered,
          newMessages: waiting,
          events: queued.map((event) => event.text),
          now,
          firstTurnToday,
          channels: yield* botChannels(bot),
        },
        seen,
      );
      const started = yield* Effect.result(dispatch(bot, packet.text, freshContext));
      if (Result.isFailure(started)) {
        yield* Effect.logWarning("A bot could not start its turn.", {
          botId,
          cause: started.failure,
        });
        return `Could not start a turn: ${started.failure.message}`;
      }
      store.startTurn(
        {
          botId,
          runId: started.success.runId,
          threadId: started.success.threadId,
          startedAt: nowIso(),
        },
        waiting.map((message) => message.id),
        queued.map((event) => event.id),
      );
      store.setSeenPacket(botId, { model: bot.modelSelection, sections: packet.sections });
      store.countTurn(botId, today);
      runtime.publish(botId);
      return null;
    }),
  );
  if (failure !== null) yield* postError(botId, failure);
});

/** The text a run ended with: its last assistant message that has any. */
const replyOf = Effect.fn("ForkBot.replyOf")(function* (
  projectId: string,
  threadId: string,
  runId: string,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const records = yield* threads.getProjectThreadRecords(
    { projectId: ProjectId.make(projectId), threadId: ThreadId.make(threadId) },
    ["messages"],
    { messageRunIds: [RunId.make(runId)], messageRoles: ["assistant"] },
  );
  const last = records.messages
    .filter((message) => message.text.trim() !== "")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    )
    .at(-1);
  return last?.text.trim() ?? null;
});

/** What a turn ends with when it has nothing worth telling the user. */
export const NO_REPLY = "NO_REPLY";

/**
 * The reply to post: models sometimes add a last line that starts with NO_REPLY to a real
 * reply. That line is for the service, never for the user; null when nothing is left.
 */
export function replyText(reply: string | null): string | null {
  if (reply === null) return null;
  const lines = reply.trimEnd().split("\n");
  while (lines.length > 0 && lines.at(-1)!.trim().startsWith(NO_REPLY)) lines.pop();
  const text = lines.join("\n").trim();
  return text === "" ? null : text;
}

/**
 * Ends the bot's turn when its run ends. Its last message is its reply, unless it already posted
 * with `say` or ended with NO_REPLY. Then the next turn may start.
 */
export const finishRun = Effect.fn("ForkBot.finishRun")(function* (
  botId: string,
  runId: string,
  status: OrchestrationV2RunStatus,
) {
  const runtime = yield* BotRuntime;
  const ended = yield* runtime.turnLock.withPermit(
    Effect.gen(function* () {
      const store = runtime.store();
      const bot = store.getBot(botId);
      const turn = store.getTurn(botId);
      if (bot === null || turn === null || turn.runId !== runId) return false;
      const reply =
        status === "completed" && !turn.said && bot.workProjectId !== null
          ? yield* replyOf(bot.workProjectId, turn.threadId, runId).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;
      const text = replyText(reply);
      const silent = reply !== null && text === null;
      const post =
        status !== "completed"
          ? { role: "error" as const, text: `The turn ended: ${status.replace("_", " ")}.` }
          : text !== null
            ? { role: "bot" as const, text }
            : turn.answersUser && !turn.said && !silent
              ? { role: "error" as const, text: "The turn ended without a reply." }
              : null;
      // A turn that did not complete may have lost what it was sent; the next one resends it all.
      if (status !== "completed") store.setSeenPacket(botId, null);
      store.endTurn(
        botId,
        runId,
        post === null ? null : { id: newId("msg"), botId, createdAt: nowIso(), ...post },
      );
      return true;
    }),
  );
  if (!ended) return;
  runtime.publish(botId);
  yield* wake(botId);
});

/** Queues an event for the bot and wakes it if the event should. */
export const notify = Effect.fn("ForkBot.notify")(function* (
  botId: string,
  text: string,
  wakes: boolean,
) {
  const runtime = yield* BotRuntime;
  runtime.store().enqueue(botId, text, wakes, nowIso());
  runtime.publish(botId);
  if (wakes) yield* wake(botId);
});

/** Fires every routine due by `now` once, however many times it was due, and sets the next. */
export const fireDueRoutines = Effect.fn("ForkBot.fireDueRoutines")(function* (
  now: Date = new Date(),
) {
  const runtime = yield* BotRuntime;
  const store = runtime.existingStore();
  if (store === null) return;
  for (const botId of store.setAsideStale(
    new Date(now.getTime() - SET_ASIDE_AFTER_DAYS * 86_400_000).toISOString(),
  )) {
    runtime.publish(botId);
  }
  for (const question of store.expireQuestions(now.toISOString())) {
    yield* notify(
      question.botId,
      `Your question ${question.id} lapsed unanswered after 24 hours; it did not run. Ask again only if it still holds.`,
      false,
    );
  }
  for (const routine of store.listRoutines()) {
    if (routine.nextDueAt === null || Date.parse(routine.nextDueAt) > now.getTime()) continue;
    store.updateRoutine(routine.botId, routine.id, {
      nextDueAt: nextDueAt(routine.schedule, now)?.toISOString() ?? null,
    });
    yield* fireRoutine(routine.botId, routine.id, new Date(routine.nextDueAt), now);
  }
});

const fireRoutine = Effect.fn("ForkBot.fireRoutine")(function* (
  botId: string,
  routineId: number,
  dueAt: Date,
  now: Date,
) {
  const routine = (yield* BotRuntime)
    .store()
    .listRoutines(botId)
    .find((candidate) => candidate.id === routineId);
  if (routine === undefined) return false;
  const late =
    now.getTime() - dueAt.getTime() > LATE_MS
      ? ` It was due at ${localTime(dueAt)} and starts late, at ${localTime(now)}.`
      : "";
  yield* notify(
    botId,
    `Routine ${routine.id} "${routine.title}" is due.${late} ${routine.prompt}`,
    true,
  );
  return true;
});

const RunRoutineInput = Schema.Struct({ botId: Schema.String, routineId: Schema.Number });

export const runRoutineNow = Effect.fn("ForkBot.runRoutineNow")(function* (input: unknown) {
  const decoded = yield* decode(RunRoutineInput, input);
  yield* requireBot(decoded.botId);
  const now = new Date();
  if (!(yield* fireRoutine(decoded.botId, decoded.routineId, now, now))) {
    return yield* new ForkHttpError({
      status: 404,
      code: "not_found",
      detail: "That routine does not exist.",
    });
  }
  return {};
});

const ItemInput = Schema.Struct({ botId: Schema.String, itemId: Schema.Number });

/** Brings a set-aside item back to the bot's open list. */
export const reopenItem = Effect.fn("ForkBot.reopenItem")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(ItemInput, input);
  const bot = yield* requireBot(decoded.botId);
  if (!runtime.store().updateItem(bot.id, decoded.itemId, {}, nowIso())) {
    return yield* new ForkHttpError({
      status: 404,
      code: "not_found",
      detail: "That item does not exist.",
    });
  }
  runtime.publish(bot.id);
  return {};
});

/** On startup: a turn whose run ended while the server was down is finished now. */
export const reconcile = Effect.fn("ForkBot.reconcile")(function* () {
  const runtime = yield* BotRuntime;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = runtime.existingStore();
  if (store === null) return;
  for (const turn of store.listTurns()) {
    const bot = store.getBot(turn.botId);
    if (bot?.workProjectId == null) continue;
    const records = yield* threads
      .getProjectThreadRecords(
        { projectId: ProjectId.make(bot.workProjectId), threadId: ThreadId.make(turn.threadId) },
        ["runs"],
        { runIds: [RunId.make(turn.runId)] },
      )
      .pipe(Effect.orElseSucceed(() => null));
    const run = records?.runs.find((candidate) => candidate.id === turn.runId);
    // A run that is gone, with its thread, will never end on its own.
    if (run === undefined) yield* finishRun(bot.id, turn.runId, "failed");
    else if (isTerminalRunStatus(run.status)) yield* finishRun(bot.id, run.id, run.status);
  }
  for (const bot of store.listBots()) yield* wake(bot.id);
});

const SeenInput = Schema.Struct({ botId: Schema.String });

/** The user saw the bot's chat up to its latest message. */
export const markSeen = Effect.fn("ForkBot.markSeen")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(SeenInput, input);
  const bot = yield* requireBot(decoded.botId);
  if (runtime.store().markSeen(bot.id)) runtime.publish(bot.id);
  return {};
});

const PauseInput = Schema.Struct({ botId: Schema.String, paused: Schema.Boolean });

/** A paused bot keeps queuing what happens and runs nothing until resumed. */
export const setPaused = Effect.fn("ForkBot.setPaused")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(PauseInput, input);
  const bot = yield* requireBot(decoded.botId);
  runtime.store().setPaused(bot.id, decoded.paused);
  runtime.publish(bot.id);
  if (!decoded.paused) yield* wake(bot.id);
  return {};
});

const Permission = Schema.Literals(["allow", "ask"]);
const SettingsInput = Schema.Struct({
  botId: Schema.String,
  settings: Schema.Struct({
    threads: Schema.optional(Permission),
    turnsPerDay: Schema.Number,
    maxThreads: Schema.Number,
    runtimeMode: Schema.optional(RuntimeMode),
    channelsEnabled: Schema.optional(Schema.Boolean),
    signature: Schema.optional(Schema.String),
    channels: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ send: Permission, mentions: Schema.Boolean })),
    ),
  }),
});

const SIGNATURE_CHARS = 200;

/** Only the user sets these; the bot has no tool for them. */
export const saveSettings = Effect.fn("ForkBot.saveSettings")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(SettingsInput, input);
  const bot = yield* requireBot(decoded.botId);
  const store = runtime.store();
  const { turnsPerDay, maxThreads } = decoded.settings;
  const runtimeMode = decoded.settings.runtimeMode ?? bot.settings.runtimeMode;
  if (!Number.isInteger(turnsPerDay) || turnsPerDay < 1 || turnsPerDay > 10_000) {
    return yield* badRequest("Give 1 to 10,000 turns a day.", "turnsPerDay");
  }
  if (!Number.isInteger(maxThreads) || maxThreads < 1 || maxThreads > 50) {
    return yield* badRequest("Give 1 to 50 threads at once.", "maxThreads");
  }
  const signature = decoded.settings.signature ?? bot.settings.signature;
  if (signature.length > SIGNATURE_CHARS) {
    return yield* badRequest(
      `Keep the signature under ${SIGNATURE_CHARS} characters.`,
      "signature",
    );
  }
  const channelsEnabled = decoded.settings.channelsEnabled ?? bot.settings.channelsEnabled;
  const now = nowIso();
  const channels: Record<string, ChannelSettings> = { ...bot.settings.channels };
  for (const [channelId, wanted] of Object.entries(decoded.settings.channels ?? {})) {
    const before = channelSettings(bot.settings, channelId);
    const mentions = channelsEnabled && wanted.mentions;
    channels[channelId] = {
      send: wanted.send,
      mentions,
      // Turning mentions on starts from now: earlier ones were the user's to handle.
      mentionsSince: mentions ? (before.mentions ? before.mentionsSince : now) : null,
    };
  }
  if (!channelsEnabled) {
    for (const [channelId, value] of Object.entries(channels)) {
      channels[channelId] = { ...value, mentions: false, mentionsSince: null };
    }
  }
  const settings: BotSettings = {
    threads: decoded.settings.threads ?? bot.settings.threads,
    turnsPerDay,
    maxThreads,
    runtimeMode,
    channelsEnabled,
    signature,
    channels,
  };
  if (bot.workThreadId !== null && runtimeMode !== bot.settings.runtimeMode) {
    yield* (yield* ThreadManagement.ThreadManagementService)
      .dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(newId("fork-bot")),
        threadId: ThreadId.make(bot.workThreadId),
        runtimeMode: yield* runtimeModeFor(bot.modelSelection, runtimeMode),
      })
      .pipe(Effect.mapError((cause) => badRequest(cause.message, "runtimeMode")));
  }
  store.setSettings(bot.id, settings);
  // One bot per channel wakes on mentions: taking a channel takes it from the bot that had it.
  for (const [channelId, value] of Object.entries(channels)) {
    if (!value.mentions) continue;
    for (const other of store.listBots()) {
      const held = other.settings.channels[channelId];
      if (other.id === bot.id || held?.mentions !== true) continue;
      store.setSettings(other.id, {
        ...other.settings,
        channels: {
          ...other.settings.channels,
          [channelId]: { ...held, mentions: false, mentionsSince: null },
        },
      });
      runtime.publish(other.id);
    }
  }
  runtime.publish(bot.id);
  // A raised budget may let a held wake run now.
  yield* wake(bot.id);
  return {};
});

const HandBackInput = Schema.Struct({ botId: Schema.String, threadId: Schema.String });

/** The user is done with a thread they took over; the bot owns it again from here. */
export const handBack = Effect.fn("ForkBot.handBack")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(HandBackInput, input);
  const bot = yield* requireBot(decoded.botId);
  const store = runtime.store();
  const owned = store.getThread(decoded.threadId);
  if (owned === null || owned.botId !== bot.id) {
    return yield* badRequest("That thread is not this bot's.", "threadId");
  }
  store.updateThread(owned.threadId, { takenOver: false, handedBackAt: nowIso() });
  yield* notify(
    bot.id,
    `The user handed thread ${owned.threadId}${owned.itemId === null ? "" : ` (item #${owned.itemId})`} back to you. Read it to see what they did, then carry on.`,
    true,
  );
  return {};
});
