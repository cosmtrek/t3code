// @effect-diagnostics nodeBuiltinImport:off - UUIDs remain synchronous.
/**
 * Bots: create one, talk to it, and run its turns. A turn starts when the user writes, a routine
 * comes due, or one of its threads needs it; it runs in the bot's one work thread and acts through
 * the `t3bot` tools.
 */
import * as NodeCrypto from "node:crypto";

import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { htmlRenderFromToolItem, sentMessageFromToolItem } from "@t3tools/shared/toolOutput";

import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  RunId,
  RuntimeMode,
  OrchestrationV2TurnItemJson,
  ThreadId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { resolveRuntimeMode } from "../../mcp/delegatedTaskModes.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { firstProviderDefault, ForkHttpError } from "../inbox/operations.ts";
import { BotRuntime } from "./BotRuntime.ts";
import { buildPacket, chatPreview, RECENT_CHAT_LIMIT, type Notebook } from "./packet.ts";
import { nextDueAt } from "./routines.ts";
import { briefFor, listInstances } from "./connectors/registry.ts";
import {
  connectorSettings,
  type Bot,
  type BotSettings,
  type ChatMessage,
  type ConnectorSettings,
  type Turn,
  TERMINAL_RUN_STATUSES,
} from "./store.ts";

/** Chat shown on the Bots page; older messages stay in the store. */
const CHAT_PAGE = 200;
const NAME_CHARS = 60;
const MESSAGE_CHARS = 20_000;
export const ROLE_CHARS = 20_000;
const SET_ASIDE_AFTER_DAYS = 14;
/** A routine starting this much after its time tells the bot both times. */
const LATE_MS = 15 * 60_000;

const TERMINAL: ReadonlySet<string> = new Set(TERMINAL_RUN_STATUSES);

export const isTerminalRunStatus = (status: string) => TERMINAL.has(status);

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

export const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
export const newId = (prefix: string) => `${prefix}_${NodeCrypto.randomUUID()}`;
const localDay = (at: DateTime.Zoned) => {
  const parts = DateTime.toParts(at);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
};
const localTime = (at: DateTime.Zoned) => {
  const parts = DateTime.toParts(at);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
};

export const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => badRequest("The request is not valid.")),
  );

const requireBot = Effect.fn("ForkBot.requireBot")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const bot = (yield* runtime.existingStore()?.getBot(botId) ?? Effect.undefined) ?? null;
  if (bot === null) return yield* notFound();
  return bot;
});

/** The bot's notebook with its threads' current titles. */
export const readNotebook = Effect.fn("ForkBot.readNotebook")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = yield* runtime.store;
  const owned = yield* store.listThreads(botId);
  const titles = yield* threads
    .getThreadTitles(owned.map((thread) => ThreadId.make(thread.threadId)))
    .pipe(Effect.orElseSucceed((): Record<ThreadId, string> => ({})));
  return {
    items: yield* store.listItems(botId),
    threads: owned.map((thread) => ({
      ...thread,
      title: titles[ThreadId.make(thread.threadId)] ?? null,
    })),
    routines: yield* store.listRoutines(botId),
    memory: yield* store.listMemory(botId),
  } satisfies Notebook;
});

export interface BotSummary {
  readonly id: string;
  readonly name: string;
  readonly modelSelection: Bot["modelSelection"];
  readonly working: boolean;
  readonly paused: boolean;
  readonly lastMessage: Pick<ChatMessage, "role" | "text" | "createdAt"> | null;
  /** Its posts since the user last looked. */
  readonly unread: number;
  /** Its questions still waiting for an answer. */
  readonly questions: number;
  /** Its own thread, which the sidebar leaves out: the bot's row stands for it. */
  readonly workThreadId: string | null;
}

export const listBots = Effect.fn("ForkBot.listBots")(function* () {
  const store = (yield* BotRuntime).existingStore();
  const bots: ReadonlyArray<BotSummary> = yield* Effect.forEach(
    yield* store?.listBots() ?? Effect.succeed([]),
    Effect.fnUntraced(function* (bot) {
      const last = (yield* store!.recentChat(bot.id, 1))[0];
      return {
        id: bot.id,
        name: bot.name,
        modelSelection: bot.modelSelection,
        working: (yield* store!.workingSince(bot.id)) !== null,
        paused: bot.paused,
        lastMessage: last
          ? {
              role: last.role,
              text: chatPreview(last.text) || (last.renders?.[0]?.title ?? ""),
              createdAt: last.createdAt,
            }
          : null,
        unread: yield* store!.unseenCount(bot.id),
        questions: (yield* store!.openQuestions(bot.id)).length,
        workThreadId: bot.workThreadId,
      };
    }),
  );
  return { bots };
});

const ACTIVITY_CHARS = 240;
/** A step's item stays small on the wire; a bigger one goes as its text alone. */
const STEP_JSON_CHARS = 8_192;

/** What a thread item gives the bot chat's status: a finished message's line, or a tool step. */
export interface ActivityLine {
  /** Repeats of the same key are not pushed again. */
  readonly key: string;
  readonly text: string;
  /** The tool item, JSON-encoded without its output, so clients label it as the timeline does. */
  readonly step?: unknown;
}

const STEP_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
]);

const encodeStep = Schema.encodeUnknownOption(OrchestrationV2TurnItemJson);

function withoutOutput(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
    case "dynamic_tool": {
      const { output: _output, ...bare } = item;
      return bare;
    }
    case "file_change": {
      const { diffStr: _diff, oldStr: _old, newStr: _new, ...bare } = item;
      return bare;
    }
    default:
      return item;
  }
}

function stepOf(item: OrchestrationV2TurnItem): unknown {
  const bare = withoutOutput(item);
  const encoded = encodeStep(bare);
  if (encoded._tag === "None") return undefined;
  return JSON.stringify(encoded.value).length > STEP_JSON_CHARS ? undefined : encoded.value;
}

const clip = (line: string) =>
  line.length > ACTIVITY_CHARS ? `${line.slice(0, ACTIVITY_CHARS - 1)}…` : line;

/**
 * The first line of a finished assistant message, or a tool call once as it starts. Streamed
 * text, reasoning and NO_REPLY are left out, so it moves once per message or tool.
 */
export function activityLine(
  item: OrchestrationV2TurnItem,
  /** The key last shown: a step already shown is not encoded again. */
  shownKey?: string,
): ActivityLine | null {
  if (STEP_TYPES.has(item.type)) {
    if (shownKey === `step:${item.id}`) return null;
    const fallback =
      item.type === "command_execution" ? item.input.split("\n")[0] : (item.title ?? item.type);
    const step = stepOf(item);
    return {
      key: `step:${item.id}`,
      text: clip(chatPreview(fallback ?? "") || item.type),
      ...(step === undefined ? {} : { step }),
    };
  }
  if (item.type !== "assistant_message" || item.streaming) return null;
  const line = (replyText(item.text) ?? "")
    .split("\n")
    .map((part) => chatPreview(part.replace(/^\s*(?:[#>*-]+|\d+\.)\s+/, "")))
    .find((part) => part !== "");
  if (line === undefined) return null;
  return { key: `text:${line}`, text: clip(line) };
}

/** The latest line since it started working, and the thread it came from. */
const activityOf = (runtime: BotRuntime["Service"], botId: string, since: string | null) => {
  const latest = runtime.activity.get(botId);
  return since === null || latest?.since !== since
    ? null
    : {
        text: latest.text,
        threadId: latest.threadId,
        ...(latest.step === undefined ? {} : { step: latest.step }),
      };
};

export const readBot = Effect.fn("ForkBot.readBot")(function* (params: URLSearchParams) {
  const runtime = yield* BotRuntime;
  const bot = yield* requireBot(params.get("botId") ?? "");
  const store = yield* runtime.store;
  const since = yield* store.workingSince(bot.id);
  return {
    // A count from an earlier day is spent: today starts at zero.
    bot: {
      ...bot,
      turnsToday:
        bot.lastTurnDay ===
        localDay(yield* DateTime.nowInCurrentZone.pipe(DateTime.withCurrentZoneLocal))
          ? bot.turnsToday
          : 0,
    },
    role: yield* runtime.files.readRole(runtime.botsDir, bot.id),
    workingSince: since,
    activity: activityOf(runtime, bot.id, since),
    chat: yield* store.recentChat(bot.id, CHAT_PAGE),
    notebook: yield* readNotebook(bot.id),
    questions: yield* store.openQuestions(bot.id),
    workspacePath: runtime.files.workspacePath(runtime.botsDir, bot.id),
    notesPath: runtime.files.notesPath(runtime.botsDir, bot.id),
    notes: yield* runtime.files.listNotes(runtime.botsDir, bot.id),
    skills: yield* runtime.files.listSkills(runtime.botsDir, bot.id),
    // For its settings: the environment's connector instances, with what each kind adds.
    connectors: yield* Effect.forEach(yield* listInstances(), ({ connector, instance }) =>
      (connector.info?.(instance.id) ?? Effect.succeed({})).pipe(
        Effect.map((info) => ({ ...instance, info })),
      ),
    ),
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
  if (!runtime.files.validName(input.name)) {
    return yield* badRequest("Name a file in the bot's folder.", "name");
  }
  const base =
    input.kind === "skill"
      ? runtime.files.ownSkillsPath(runtime.botsDir, bot.id)
      : input.kind === "shared-skill"
        ? runtime.files.sharedSkillsPath(runtime.botsDir)
        : runtime.files.notesPath(runtime.botsDir, bot.id);
  const text = yield* runtime.files.readNote(
    base,
    input.name,
    input.kind === "skill" || input.kind === "shared-skill",
  );
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
  brief: Schema.optional(Schema.NullOr(Schema.String)),
});

export const createBot = Effect.fn("ForkBot.createBot")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(CreateInput, input);
  const name = decoded.name.trim();
  if (name === "" || name.length > NAME_CHARS) {
    return yield* badRequest(`Name the bot in 1 to ${NAME_CHARS} characters.`, "name");
  }
  const brief = decoded.brief?.trim() ?? "";
  if (brief.length > MESSAGE_CHARS) {
    return yield* badRequest(`Write 1 to ${MESSAGE_CHARS} characters.`, "brief");
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
  yield* runtime.files
    .ensureWorkspace(runtime.botsDir, id)
    .pipe(Effect.mapError((error) => internal(error.reason.cause)));
  yield* runtime.files
    .writeToken(runtime.botsDir, id)
    .pipe(Effect.mapError((error) => internal(error.reason.cause)));
  yield* (yield* runtime.store).createBot(
    { id, name, modelSelection, createdAt: yield* nowIso },
    decoded.runtimeMode ?? (yield* runtimeModeFor(modelSelection, "auto")),
    brief === "" ? undefined : { id: newId("msg"), text: brief },
  );
  yield* runtime.active.open;
  runtime.publish(id);
  if (brief !== "") yield* wake(id);
  return { botId: id };
});

/** A rule goes on its own line at the end, as a list item unless it already is one. */
export function appendRule(role: string, rule: string): string {
  const line = /^\s*(?:[-*+]|\d+[.)])\s/.test(rule) ? rule.trim() : `- ${rule.trim()}`;
  return role.trim() === "" ? line : `${role.trimEnd()}\n${line}`;
}

const RoleInput = Schema.Struct({ botId: Schema.String, role: Schema.String });

export const saveRole = Effect.fn("ForkBot.saveRole")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(RoleInput, input);
  const bot = yield* requireBot(decoded.botId);
  if (decoded.role.length > ROLE_CHARS) {
    return yield* badRequest(`Keep the role under ${ROLE_CHARS} characters.`, "role");
  }
  yield* runtime.files
    .writeRole(runtime.botsDir, bot.id, decoded.role)
    .pipe(Effect.mapError((error) => internal(error.reason.cause)));
  yield* (yield* runtime.store).enqueue(bot.id, "The user edited your role.", false, yield* nowIso);
  runtime.publish(bot.id);
  return {};
});

const BotIdInput = Schema.Struct({ botId: Schema.String });

/** Its threads stay as ordinary threads; only the bot and its notebook go. */
export const deleteBot = Effect.fn("ForkBot.deleteBot")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const bot = yield* requireBot((yield* decode(BotIdInput, input)).botId);
  const store = yield* runtime.store;
  yield* runtime.turnLock.withPermit(
    Effect.gen(function* () {
      yield* store.deleteBot(bot.id);
      if (bot.workThreadId !== null) runtime.workThreads.delete(bot.workThreadId);
      for (const [threadId, owner] of runtime.ownedThreads) {
        if (owner === bot.id) runtime.ownedThreads.delete(threadId);
      }
    }),
  );
  yield* runtime.files.removeBot(runtime.botsDir, bot.id);
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
  yield* (yield* runtime.store).addChat({
    id: messageId,
    botId: bot.id,
    role: "user",
    text,
    createdAt: yield* nowIso,
  });
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
      const store = yield* runtime.store;
      const turn = yield* store.getTurn(bot.id);
      if (turn === null || bot.workProjectId === null) return false;
      const sent = yield* Effect.result(
        threads.sendToThread({
          projectId: ProjectId.make(bot.workProjectId),
          commandId: CommandId.make(newId("fork-bot")),
          threadId: ThreadId.make(turn.threadId),
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          text: `The user, while you work:\n${expandAssistantCitationsForProvider(text)}`,
          attachments: [],
          mode: "steer",
          createdBy: "system",
          creationSource: "server",
        }),
      );
      if (Result.isFailure(sent) || sent.success.delivery !== "steered") return false;
      yield* store.markAnswered(bot.id, turn.runId, [messageId]);
      runtime.publish(bot.id);
      return true;
    }),
  );
});

export const postError = Effect.fn("ForkBot.postError")(function* (botId: string, text: string) {
  const runtime = yield* BotRuntime;
  yield* (yield* runtime.store).addChat({
    id: newId("msg"),
    botId,
    role: "error",
    text,
    createdAt: yield* nowIso,
  });
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

/** A model as the `thread start` flags that pick it. */
export const modelFlags = (selection: ModelSelection) =>
  `--provider ${selection.instanceId} --model ${selection.model}`;

/** What its threads run on unless it names another: its own model when the set one is gone. */
export const threadModelFor = Effect.fn("ForkBot.threadModelFor")(function* (bot: Bot) {
  const wanted = bot.settings.threadModel;
  if (wanted === null) return bot.modelSelection;
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  return providers.some((provider) => provider.instanceId === wanted.instanceId)
    ? wanted
    : bot.modelSelection;
});

/**
 * Puts the work thread in the bot's mode. The thread can drift from it: sending from its composer
 * sets the composer's mode, so each turn re-applies the bot's.
 */
const alignWorkThreadMode = Effect.fn("ForkBot.alignWorkThreadMode")(function* (bot: Bot) {
  if (bot.workThreadId === null) return;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(bot.workThreadId);
  const shell = yield* threads.getThreadShell(threadId);
  const wanted = yield* runtimeModeFor(bot.modelSelection, bot.settings.runtimeMode);
  if (shell === null || shell.runtimeMode === wanted) return;
  yield* threads.dispatch({
    type: "thread.runtime-mode.set",
    commandId: CommandId.make(newId("fork-bot")),
    threadId,
    runtimeMode: wanted,
  });
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
    yield* alignWorkThreadMode(bot).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("A bot could not set its work thread's mode.", { cause }),
      ),
    );
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
    title: workThreadTitle(bot.name),
    modelSelection,
    runtimeMode: yield* runtimeModeFor(modelSelection, bot.settings.runtimeMode),
    interactionMode: "default",
    workspaceStrategy: {
      type: "existing_worktree",
      worktreePath: runtime.files.workspacePath(runtime.botsDir, bot.id),
    },
    initialMessage: { messageId, text: packet, attachments: [] },
    createdBy: "system",
    creationSource: "server",
  });
  const run = launched.projection.runs.find((candidate) => candidate.userMessageId === messageId);
  if (run === undefined) return yield* internal("The work thread started no run.");
  yield* (yield* runtime.store).setWorkThread(bot.id, launched.threadId, projectId);
  runtime.workThreads.set(launched.threadId, bot.id);
  return { threadId: launched.threadId, runId: run.id };
});

const workThreadTitle = (name: string) => `${name} (bot)`;

const sameModel = (left: ModelSelection, right: ModelSelection) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Quotes a word for a POSIX shell; the state folder may hold spaces (`Application Support`). */
export const shellQuote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

const toolCommand = (runtime: BotRuntime["Service"], botId: string) =>
  `${shellQuote(runtime.cliPath)} --bot ${shellQuote(botId)}`;

/** Starts a turn when the user wrote or something that wakes the bot is queued, unless one runs. */
const wake = Effect.fn("ForkBot.wake")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const failure = yield* runtime.turnLock.withPermit(
    Effect.gen(function* () {
      const store = yield* runtime.store;
      const bot = yield* store.getBot(botId);
      if (bot === null || bot.paused || (yield* store.getTurn(botId)) !== null) return null;
      const waiting = yield* store.waitingMessages(botId);
      const queued = yield* store.queued(botId);
      if (waiting.length === 0 && !queued.some((event) => event.wakes)) return null;
      const now = yield* DateTime.nowInCurrentZone.pipe(DateTime.withCurrentZoneLocal);
      const today = localDay(now);
      const firstTurnToday = bot.lastTurnDay !== today;
      const turnsToday = firstTurnToday ? 0 : bot.turnsToday;
      if (turnsToday >= bot.settings.turnsPerDay) {
        return (yield* store.noteBudgetSpent(botId, today))
          ? `${bot.name} used its ${bot.settings.turnsPerDay} turns for today. What happens meanwhile waits for tomorrow, or raise its budget.`
          : null;
      }
      yield* runtime.ensureCli;
      yield* runtime.files.writeToken(runtime.botsDir, botId);
      yield* runtime.files.ensureWorkspace(runtime.botsDir, botId);
      const answered = (yield* store.recentChat(botId, RECENT_CHAT_LIMIT + waiting.length)).filter(
        (message) => !waiting.some((candidate) => candidate.id === message.id),
      );
      // A new day starts a fresh provider session; the full packet carries all a turn needs. So
      // does a move to another provider, rather than handing it this session's transcript.
      const seenModel = yield* store.seenModel(botId);
      const freshContext =
        (firstTurnToday && bot.lastTurnDay !== null) ||
        (bot.workThreadId !== null &&
          seenModel !== null &&
          seenModel.instanceId !== bot.modelSelection.instanceId);
      const seen =
        freshContext || bot.workThreadId === null
          ? null
          : yield* store.seenPacket(botId, bot.modelSelection);
      const packet = buildPacket(
        {
          name: bot.name,
          role: yield* runtime.files.readRole(runtime.botsDir, botId),
          tool: toolCommand(runtime, botId),
          notebook: yield* readNotebook(botId),
          notesPath: runtime.files.notesPath(runtime.botsDir, botId),
          notes: yield* runtime.files.listNotes(runtime.botsDir, botId),
          skillsPath: runtime.files.ownSkillsPath(runtime.botsDir, botId),
          sharedSkillsPath: runtime.files.sharedSkillsPath(runtime.botsDir),
          skills: yield* runtime.files.listSkills(runtime.botsDir, botId),
          questions: yield* store.openQuestions(botId),
          recentChat: answered,
          newMessages: waiting,
          events: queued.map((event) => event.text),
          now: DateTime.toDateUtc(now),
          firstTurnToday,
          connectors: yield* briefFor(bot),
          threadModel: modelFlags(yield* threadModelFor(bot)),
        },
        seen,
      );
      const started = yield* Effect.result(
        dispatch(bot, packet.text, freshContext).pipe(
          Effect.catchTags({ BotStoreError: Effect.die }),
        ),
      );
      if (Result.isFailure(started)) {
        yield* Effect.logWarning("A bot could not start its turn.", {
          botId,
          cause: started.failure,
        });
        return `Could not start a turn: ${started.failure.message}`;
      }
      yield* store.startTurn(
        {
          botId,
          runId: started.success.runId,
          threadId: started.success.threadId,
          startedAt: yield* nowIso,
        },
        waiting.map((message) => message.id),
        queued.map((event) => event.id),
      );
      yield* store.setSeenPacket(botId, { model: bot.modelSelection, sections: packet.sections });
      yield* store.countTurn(botId, today);
      runtime.publish(botId);
      return null;
    }),
  );
  if (failure !== null) yield* postError(botId, failure);
});

/** The text a run ended with: its last assistant message that has any. */
export const replyOf = Effect.fn("ForkBot.replyOf")(function* (
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

type ChatPost = Omit<ChatMessage, "turnRunId">;

/**
 * What the agent showed the user in the work thread (`html_render` pages, `send_to_user` text)
 * that the chat does not have yet, posted in order before `last`. The chat is where the user
 * reads a bot, so what the thread shows must reach it too. A page goes with the next message.
 */
export const withShown = Effect.fn("ForkBot.withShown")(function* (
  bot: Bot,
  turn: Turn,
  last: ChatPost | null,
) {
  const store = yield* (yield* BotRuntime).store;
  const items =
    bot.workProjectId === null
      ? []
      : (yield* (yield* ThreadManagement.ThreadManagementService)
          .getProjectThreadRecords(
            {
              projectId: ProjectId.make(bot.workProjectId),
              threadId: ThreadId.make(turn.threadId),
            },
            ["turnItems"],
            {
              turnItemRunId: RunId.make(turn.runId),
              turnItemTypes: ["dynamic_tool"],
              turnItemStatuses: ["completed"],
            },
          )
          .pipe(Effect.orElseSucceed(() => ({ turnItems: [] })))).turnItems;
  const postedPages = yield* store.postedRenderIds(bot.id, turn.startedAt);
  const posts: ChatPost[] = [];
  let pages: Array<HtmlRenderReference> = [];
  const post = (message: ChatPost) => {
    posts.push(pages.length === 0 ? message : { ...message, renders: pages });
    pages = [];
  };
  for (const item of items.toSorted((left, right) => left.ordinal - right.ordinal)) {
    if (item.type !== "dynamic_tool") continue;
    const page = htmlRenderFromToolItem(item);
    if (page !== undefined && !postedPages.has(page.attachmentId)) pages = [...pages, page];
    const sent = sentMessageFromToolItem(item)?.trim();
    // Its id comes from the tool call, so a later look at the same run finds it posted.
    const id = `msg_shown_${item.id}`;
    if (sent && !(yield* store.hasChat(id))) {
      post({ id, botId: bot.id, role: "bot", text: sent, createdAt: yield* nowIso });
    }
  }
  if (pages.length > 0 && last?.role !== "bot") {
    post({ id: newId("msg"), botId: bot.id, role: "bot", text: "", createdAt: yield* nowIso });
  }
  if (last !== null) post(last);
  return posts;
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
      const store = yield* runtime.store;
      const bot = yield* store.getBot(botId);
      const turn = yield* store.getTurn(botId);
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
            : null;
      // A turn that did not complete may have lost what it was sent; the next one resends it all.
      if (status !== "completed") yield* store.setSeenPacket(botId, null);
      const posts = yield* withShown(
        bot,
        turn,
        post === null ? null : { id: newId("msg"), botId, createdAt: yield* nowIso, ...post },
      );
      const owed = turn.answersUser && !turn.said && !silent && status === "completed";
      yield* store.endTurn(
        botId,
        runId,
        owed && posts.length === 0
          ? [
              {
                id: newId("msg"),
                botId,
                role: "error",
                text: "The turn ended without a reply.",
                createdAt: yield* nowIso,
              },
            ]
          : posts,
        yield* nowIso,
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
  yield* (yield* runtime.store).enqueue(botId, text, wakes, yield* nowIso);
  runtime.publish(botId);
  if (wakes) yield* wake(botId);
});

/** Fires every routine due by `now` once, however many times it was due, and sets the next. */
export const fireDueRoutines = Effect.fn("ForkBot.fireDueRoutines")(function* (
  at?: DateTime.Zoned,
) {
  const now = at ?? (yield* DateTime.nowInCurrentZone.pipe(DateTime.withCurrentZoneLocal));
  const runtime = yield* BotRuntime;
  const store = runtime.existingStore();
  if (store === null) return;
  for (const botId of yield* store.setAsideStale(
    DateTime.formatIso(DateTime.subtractDuration(now, SET_ASIDE_AFTER_DAYS * 86_400_000)),
  )) {
    runtime.publish(botId);
  }
  for (const question of yield* store.expireQuestions(DateTime.formatIso(now))) {
    yield* notify(
      question.botId,
      `Your question ${question.id} lapsed unanswered after 24 hours; it did not run. Ask again only if it still holds.`,
      false,
    );
  }
  for (const routine of yield* store.listRoutines()) {
    if (routine.nextDueAt === null || Date.parse(routine.nextDueAt) > DateTime.toEpochMillis(now))
      continue;
    yield* store.updateRoutine(routine.botId, routine.id, {
      nextDueAt: nextDueAt(routine.schedule, now)?.pipe(DateTime.formatIso) ?? null,
    });
    yield* fireRoutine(
      routine.botId,
      routine.id,
      DateTime.makeZonedUnsafe(routine.nextDueAt, { timeZone: now.zone }),
      now,
    );
  }
});

const fireRoutine = Effect.fn("ForkBot.fireRoutine")(function* (
  botId: string,
  routineId: number,
  dueAt: DateTime.Zoned,
  now: DateTime.Zoned,
) {
  const routine = (yield* (yield* (yield* BotRuntime).store).listRoutines(botId)).find(
    (candidate) => candidate.id === routineId,
  );
  if (routine === undefined) return false;
  const late =
    DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > LATE_MS
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
  const now = yield* DateTime.nowInCurrentZone.pipe(DateTime.withCurrentZoneLocal);
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
  if (!(yield* (yield* runtime.store).updateItem(bot.id, decoded.itemId, {}, yield* nowIso))) {
    return yield* new ForkHttpError({
      status: 404,
      code: "not_found",
      detail: "That item does not exist.",
    });
  }
  runtime.publish(bot.id);
  return {};
});

const MemoryInput = Schema.Struct({ botId: Schema.String, memoryId: Schema.Number });

/** Removes one memory note the user no longer wants the bot to keep. */
export const forgetMemory = Effect.fn("ForkBot.forgetMemory")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(MemoryInput, input);
  const bot = yield* requireBot(decoded.botId);
  if (!(yield* (yield* runtime.store).removeMemory(bot.id, decoded.memoryId))) {
    return yield* new ForkHttpError({
      status: 404,
      code: "not_found",
      detail: "That memory does not exist.",
    });
  }
  runtime.publish(bot.id);
  return {};
});

/** The user moves a note the bot filed as memory into its role, where a rule belongs. */
export const moveMemoryToRole = Effect.fn("ForkBot.moveMemoryToRole")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(MemoryInput, input);
  const bot = yield* requireBot(decoded.botId);
  const store = yield* runtime.store;
  const note = (yield* store.listMemory(bot.id)).find((entry) => entry.id === decoded.memoryId);
  if (note === undefined) {
    return yield* new ForkHttpError({
      status: 404,
      code: "not_found",
      detail: "That memory does not exist.",
    });
  }
  const role = appendRule(yield* runtime.files.readRole(runtime.botsDir, bot.id), note.text);
  if (role.length > ROLE_CHARS) {
    return yield* badRequest(`Keep the role under ${ROLE_CHARS} characters.`, "role");
  }
  yield* runtime.files
    .writeRole(runtime.botsDir, bot.id, role)
    .pipe(Effect.mapError((error) => internal(error.reason.cause)));
  yield* store.removeMemory(bot.id, note.id);
  yield* store.enqueue(
    bot.id,
    `The user moved memory ${note.id} into your role.`,
    false,
    yield* nowIso,
  );
  runtime.publish(bot.id);
  return {};
});

/** On startup: a turn whose run ended while the server was down is finished now. */
export const reconcile = Effect.fn("ForkBot.reconcile")(function* () {
  const runtime = yield* BotRuntime;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const store = runtime.existingStore();
  if (store === null) return;
  for (const turn of yield* store.listTurns()) {
    const bot = yield* store.getBot(turn.botId);
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
  for (const bot of yield* store.listBots()) yield* wake(bot.id);
});

const SeenInput = Schema.Struct({ botId: Schema.String });

/** The user saw the bot's chat up to its latest message. */
export const markSeen = Effect.fn("ForkBot.markSeen")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(SeenInput, input);
  const bot = yield* requireBot(decoded.botId);
  if (yield* (yield* runtime.store).markSeen(bot.id)) runtime.publish(bot.id);
  return {};
});

const PauseInput = Schema.Struct({ botId: Schema.String, paused: Schema.Boolean });

/** A paused bot keeps queuing what happens and runs nothing until resumed. */
export const setPaused = Effect.fn("ForkBot.setPaused")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(PauseInput, input);
  const bot = yield* requireBot(decoded.botId);
  yield* (yield* runtime.store).setPaused(bot.id, decoded.paused);
  runtime.publish(bot.id);
  if (!decoded.paused) yield* wake(bot.id);
  return {};
});

const Permission = Schema.Literals(["allow", "ask"]);
const SettingsInput = Schema.Struct({
  botId: Schema.String,
  name: Schema.optional(Schema.String),
  modelSelection: Schema.optional(Schema.Unknown),
  settings: Schema.Struct({
    turnsPerDay: Schema.Number,
    maxThreads: Schema.Number,
    runtimeMode: Schema.optional(RuntimeMode),
    /** Left out keeps it; null runs its threads on its own model. */
    threadModel: Schema.optional(Schema.NullOr(Schema.Unknown)),
    /** By instance id; instances left out keep what they had. */
    connectors: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          enabled: Schema.Boolean,
          permissions: Schema.optional(Schema.Record(Schema.String, Permission)),
          config: Schema.optional(Schema.Unknown),
        }),
      ),
    ),
  }),
});

/** Only the user sets these; the bot has no tool for them. */
export const saveSettings = Effect.fn("ForkBot.saveSettings")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(SettingsInput, input);
  const bot = yield* requireBot(decoded.botId);
  const store = yield* runtime.store;
  const { turnsPerDay, maxThreads } = decoded.settings;
  const runtimeMode = decoded.settings.runtimeMode ?? bot.settings.runtimeMode;
  if (!Number.isInteger(turnsPerDay) || turnsPerDay < 1 || turnsPerDay > 10_000) {
    return yield* badRequest("Give 1 to 10,000 turns a day.", "turnsPerDay");
  }
  if (!Number.isInteger(maxThreads) || maxThreads < 1 || maxThreads > 50) {
    return yield* badRequest("Give 1 to 50 threads at once.", "maxThreads");
  }
  const name = decoded.name?.trim() ?? bot.name;
  if (name === "" || name.length > NAME_CHARS) {
    return yield* badRequest(`Name the bot in 1 to ${NAME_CHARS} characters.`, "name");
  }
  const pickModel = (value: unknown, field: string) =>
    decode(ModelSelection, value).pipe(Effect.mapError(() => badRequest("Choose a model.", field)));
  const modelSelection =
    decoded.modelSelection === undefined
      ? bot.modelSelection
      : yield* pickModel(decoded.modelSelection, "modelSelection");
  const wantedThreadModel = decoded.settings.threadModel;
  const threadModel =
    wantedThreadModel === undefined
      ? bot.settings.threadModel
      : wantedThreadModel === null
        ? null
        : yield* pickModel(wantedThreadModel, "threadModel");
  const instances = yield* listInstances();
  const now = yield* nowIso;
  const connectors: Record<string, ConnectorSettings> = Object.fromEntries(
    // Settings of instances the environment no longer has are dropped.
    Object.entries(bot.settings.connectors).filter(([id]) =>
      instances.some((entry) => entry.instance.id === id),
    ),
  );
  const saved: Array<(typeof instances)[number]> = [];
  for (const [instanceId, wanted] of Object.entries(decoded.settings.connectors ?? {})) {
    const entry = instances.find((candidate) => candidate.instance.id === instanceId);
    if (entry === undefined) return yield* badRequest(`No connector "${instanceId}" here.`);
    const before = connectorSettings(bot.settings, instanceId);
    const operations = new Set(entry.instance.operations.map((operation) => operation.id));
    connectors[instanceId] = {
      enabled: wanted.enabled,
      permissions: Object.fromEntries(
        Object.entries({ ...before.permissions, ...wanted.permissions }).filter(([operation]) =>
          operations.has(operation),
        ),
      ),
      config: yield* entry.connector.config(wanted.config ?? {}, {
        before,
        enabled: wanted.enabled,
        now,
      }),
    };
    saved.push(entry);
  }
  const settings: BotSettings = {
    turnsPerDay,
    maxThreads,
    runtimeMode,
    threadModel,
    connectors,
  };
  yield* alignWorkThreadMode({ ...bot, modelSelection, settings }).pipe(
    Effect.mapError((cause) => badRequest(cause.message, "runtimeMode")),
  );
  yield* store.setSettings(bot.id, settings);
  if (name !== bot.name || !sameModel(modelSelection, bot.modelSelection)) {
    yield* store.setProfile(bot.id, name, modelSelection);
  }
  if (name !== bot.name) yield* renamed(bot, name);
  for (const { connector, instance } of saved) {
    if (connector.afterSave !== undefined) yield* connector.afterSave(bot.id, instance.id);
  }
  runtime.publish(bot.id);
  // A raised budget may let a held wake run now.
  yield* wake(bot.id);
  return {};
});

/**
 * Its work thread's title follows the name. A running session met the bot under its old name,
 * which only a fresh packet repeats, so it hears of the new one.
 */
const renamed = Effect.fn("ForkBot.renamed")(function* (bot: Bot, name: string) {
  if (bot.workThreadId !== null) {
    yield* (yield* ThreadManagement.ThreadManagementService)
      .dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(newId("fork-bot")),
        threadId: ThreadId.make(bot.workThreadId),
        title: workThreadTitle(name),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("A bot could not retitle its work thread.", { cause }),
        ),
      );
  }
  yield* notify(bot.id, `The user renamed you from ${bot.name} to ${name}.`, false);
});

const HandBackInput = Schema.Struct({ botId: Schema.String, threadId: Schema.String });

/** The user is done with a thread they took over; the bot owns it again from here. */
export const handBack = Effect.fn("ForkBot.handBack")(function* (input: unknown) {
  const runtime = yield* BotRuntime;
  const decoded = yield* decode(HandBackInput, input);
  const bot = yield* requireBot(decoded.botId);
  const store = yield* runtime.store;
  const owned = yield* store.getThread(decoded.threadId);
  if (owned === null || owned.botId !== bot.id) {
    return yield* badRequest("That thread is not this bot's.", "threadId");
  }
  const handedBackAt = yield* nowIso;
  yield* store.updateThread(owned.threadId, { takenOver: false, handedBackAt }, handedBackAt);
  yield* notify(
    bot.id,
    `The user handed thread ${owned.threadId}${owned.itemId === null ? "" : ` (item #${owned.itemId})`} back to you. Read it to see what they did, then carry on.`,
    true,
  );
  return {};
});
