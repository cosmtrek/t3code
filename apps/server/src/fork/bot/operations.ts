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
  ThreadId,
  type OrchestrationV2RunStatus,
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
import { BotRuntime, type BotRuntimeShape } from "./BotRuntime.ts";
import { buildPacket, RECENT_CHAT_LIMIT, type Notebook } from "./packet.ts";
import { nextDueAt } from "./routines.ts";
import type { Bot, ChatMessage } from "./store.ts";

/** Chat shown on the Bots page; older messages stay in the store. */
const CHAT_PAGE = 200;
const NAME_CHARS = 60;
const MESSAGE_CHARS = 20_000;
const ROLE_CHARS = 20_000;
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

export const isTerminalRunStatus = (status: OrchestrationV2RunStatus) => TERMINAL.has(status);

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

const rolePath = (botsDir: string, botId: string) => NodePath.join(botsDir, botId, "role.md");
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
    goals: store.listGoals(botId),
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
  readonly lastMessage: Pick<ChatMessage, "role" | "text" | "createdAt"> | null;
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
      lastMessage: last ? { role: last.role, text: last.text, createdAt: last.createdAt } : null,
    };
  });
  return { bots };
});

export const readBot = Effect.fn("ForkBot.readBot")(function* (params: URLSearchParams) {
  const runtime = yield* BotRuntime;
  const bot = yield* requireBot(params.get("botId") ?? "");
  const store = runtime.store();
  return {
    bot,
    role: yield* readRole(runtime.botsDir, bot.id),
    working: store.getTurn(bot.id) !== null,
    chat: store.recentChat(bot.id, CHAT_PAGE),
    notebook: yield* readNotebook(bot.id),
  };
});

const CreateInput = Schema.Struct({
  name: Schema.String,
  modelSelection: Schema.optional(Schema.NullOr(Schema.Unknown)),
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
      await NodeFSP.mkdir(NodePath.join(runtime.botsDir, id), { recursive: true });
      await writeToken(runtime.botsDir, id);
    },
    catch: internal,
  });
  runtime.store().createBot({ id, name, modelSelection, createdAt: nowIso() });
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

const postError = Effect.fn("ForkBot.postError")(function* (botId: string, text: string) {
  const runtime = yield* BotRuntime;
  runtime.store().addChat({ id: newId("msg"), botId, role: "error", text, createdAt: nowIso() });
  runtime.publish(botId);
});

/** Work threads and the threads bots start run in auto mode: they need their shell. */
export const runtimeModeFor = Effect.fn("ForkBot.runtimeModeFor")(function* (
  modelSelection: ModelSelection,
) {
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  return yield* resolveRuntimeMode("auto", undefined, {
    modelSelection,
    supportedRuntimeModes: providers.find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    )?.supportedRuntimeModes,
  }).pipe(Effect.orElseSucceed(() => "auto" as const));
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
    runtimeMode: yield* runtimeModeFor(modelSelection),
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
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

const toolCommand = (runtime: BotRuntimeShape, botId: string) =>
  `${runtime.cliPath} --bot ${botId}`;

/** Starts a turn when the user wrote or something that wakes the bot is queued, unless one runs. */
const wake = Effect.fn("ForkBot.wake")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const failure = yield* runtime.turnLock.withPermit(
    Effect.gen(function* () {
      const store = runtime.store();
      const bot = store.getBot(botId);
      if (bot === null || store.getTurn(botId) !== null) return null;
      const waiting = store.waitingMessages(botId);
      const queued = store.queued(botId);
      if (waiting.length === 0 && !queued.some((event) => event.wakes)) return null;
      yield* runtime.ensureCli;
      yield* Effect.promise(() => writeToken(runtime.botsDir, botId));
      const answered = store
        .recentChat(botId, RECENT_CHAT_LIMIT + waiting.length)
        .filter((message) => !waiting.some((candidate) => candidate.id === message.id));
      const now = new Date();
      const today = localDay(now);
      const firstTurnToday = bot.lastTurnDay !== today;
      const packet = buildPacket({
        name: bot.name,
        role: yield* readRole(runtime.botsDir, botId),
        tool: toolCommand(runtime, botId),
        notebook: yield* readNotebook(botId),
        recentChat: answered,
        newMessages: waiting,
        events: queued.map((event) => event.text),
        now,
        firstTurnToday,
      });
      // A new day starts a fresh provider session; the packet carries all a turn needs.
      const started = yield* Effect.result(
        dispatch(bot, packet, firstTurnToday && bot.lastTurnDay !== null),
      );
      if (Result.isFailure(started)) return started.failure;
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
      store.setLastTurnDay(botId, today);
      runtime.publish(botId);
      return null;
    }),
  );
  if (failure !== null) {
    yield* Effect.logWarning("A bot could not start its turn.", { botId, cause: failure });
    yield* postError(
      botId,
      `Could not start a turn: ${failure instanceof Error ? failure.message : String(failure)}`,
    );
  }
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
      const silent = reply === NO_REPLY;
      const post =
        status !== "completed"
          ? { role: "error" as const, text: `The turn ended: ${status.replace("_", " ")}.` }
          : reply !== null && !silent
            ? { role: "bot" as const, text: reply }
            : turn.answersUser && !turn.said && !silent
              ? { role: "error" as const, text: "The turn ended without a reply." }
              : null;
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
  store.setAsideStale(new Date(now.getTime() - SET_ASIDE_AFTER_DAYS * 86_400_000).toISOString());
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
  if (routine === undefined) return;
  const late =
    now.getTime() - dueAt.getTime() > LATE_MS
      ? ` It was due at ${localTime(dueAt)} and starts late, at ${localTime(now)}.`
      : "";
  yield* notify(
    botId,
    `Routine ${routine.id} "${routine.title}" is due.${late} ${routine.prompt}`,
    true,
  );
});

const RunRoutineInput = Schema.Struct({ botId: Schema.String, routineId: Schema.Number });

export const runRoutineNow = Effect.fn("ForkBot.runRoutineNow")(function* (input: unknown) {
  const decoded = yield* decode(RunRoutineInput, input);
  yield* requireBot(decoded.botId);
  const now = new Date();
  yield* fireRoutine(decoded.botId, decoded.routineId, now, now);
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
