// @effect-diagnostics nodeBuiltinImport:off globalDate:off - role.md is a plain file the user may edit; times are stored as ISO text.
/**
 * Bots: create one, talk to it, read its chat and role. Each user message runs one turn in the
 * bot's work thread; the turn's last assistant message comes back as the bot's reply.
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
import { BotRuntime } from "./BotRuntime.ts";
import { buildPacket, RECENT_CHAT_LIMIT } from "./packet.ts";
import type { Bot, ChatMessage } from "./store.ts";

/** Chat shown on the Bots page; older messages stay in the store. */
const CHAT_PAGE = 200;
const NAME_CHARS = 60;
const MESSAGE_CHARS = 20_000;
const ROLE_CHARS = 20_000;

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

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${NodeCrypto.randomUUID()}`;

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => badRequest("The request is not valid.")),
  );

const rolePath = (botsDir: string, botId: string) => NodePath.join(botsDir, botId, "role.md");

const readRole = (botsDir: string, botId: string) =>
  Effect.promise(() => NodeFSP.readFile(rolePath(botsDir, botId), "utf8").catch(() => ""));

const requireBot = Effect.fn("ForkBot.requireBot")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const bot = runtime.existingStore()?.getBot(botId) ?? null;
  if (bot === null) return yield* notFound();
  return bot;
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
    try: () => NodeFSP.mkdir(NodePath.join(runtime.botsDir, id), { recursive: true }),
    catch: internal,
  });
  runtime.store().createBot({ id, name, modelSelection, createdAt: now() });
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
  runtime.publish(bot.id);
  return {};
});

const BotIdInput = Schema.Struct({ botId: Schema.String });

/** Its threads stay as ordinary threads; only the bot and its chat go. */
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
  runtime.store().addChat({ id: messageId, botId: bot.id, role: "user", text, createdAt: now() });
  runtime.publish(bot.id);
  yield* wake(bot.id);
  return { messageId };
});

const postError = Effect.fn("ForkBot.postError")(function* (botId: string, text: string) {
  const runtime = yield* BotRuntime;
  runtime.store().addChat({ id: newId("msg"), botId, role: "error", text, createdAt: now() });
  runtime.publish(botId);
});

/** Sends the packet as a new turn: launches the work thread on the first one. */
const dispatch = Effect.fn("ForkBot.dispatch")(function* (bot: Bot, packet: string) {
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
      createdBy: "system",
      creationSource: "server",
    });
    return { threadId: bot.workThreadId, runId: sent.run.id };
  }
  const { projectId } = yield* (yield* ManagedProjectFolders).ensureScratchProject;
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  // The work thread runs the bot's CLI from its shell, so it needs more than approval-required.
  const runtimeMode = yield* resolveRuntimeMode("auto", undefined, {
    modelSelection,
    supportedRuntimeModes: providers.find(
      (provider) => provider.instanceId === modelSelection.instanceId,
    )?.supportedRuntimeModes,
  }).pipe(Effect.orElseSucceed(() => "auto" as const));
  const launched = yield* ThreadMessageIntake.launchThread({
    commandId,
    threadId: ThreadId.make(commandId),
    projectId,
    title: `${bot.name} (bot)`,
    modelSelection,
    runtimeMode,
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

/** Starts a turn for the bot's waiting messages, unless one is running. */
const wake = Effect.fn("ForkBot.wake")(function* (botId: string) {
  const runtime = yield* BotRuntime;
  const failure = yield* runtime.turnLock.withPermit(
    Effect.gen(function* () {
      const store = runtime.store();
      const bot = store.getBot(botId);
      if (bot === null || store.getTurn(botId) !== null) return null;
      const waiting = store.waitingMessages(botId);
      if (waiting.length === 0) return null;
      const answered = store
        .recentChat(botId, RECENT_CHAT_LIMIT + waiting.length)
        .filter((message) => !waiting.some((candidate) => candidate.id === message.id));
      const packet = buildPacket({
        name: bot.name,
        role: yield* readRole(runtime.botsDir, botId),
        recentChat: answered,
        newMessages: waiting,
      });
      const started = yield* Effect.result(dispatch(bot, packet));
      if (Result.isFailure(started)) return started.failure;
      store.startTurn(
        {
          botId,
          runId: started.success.runId,
          threadId: started.success.threadId,
          startedAt: now(),
        },
        waiting.map((message) => message.id),
      );
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

/** Ends the bot's turn on its run's end, posts the reply, and starts the next turn if messages wait. */
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
        status === "completed" && bot.workProjectId !== null
          ? yield* replyOf(bot.workProjectId, turn.threadId, runId).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;
      store.endTurn(botId, runId, {
        id: newId("msg"),
        botId,
        role: reply === null ? "error" : "bot",
        text:
          reply ??
          (status === "completed"
            ? "The turn ended without a reply."
            : `The turn ended: ${status.replace("_", " ")}.`),
        createdAt: now(),
      });
      return true;
    }),
  );
  if (!ended) return;
  runtime.publish(botId);
  yield* wake(botId);
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
