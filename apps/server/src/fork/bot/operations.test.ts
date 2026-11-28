// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off - Bots keep their role in a temporary folder; routines run on local wall-clock dates.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as NodePath from "node:path";

import { ProjectId, type OrchestrationV2RunStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Artifacts from "../inbox/artifacts.ts";
import * as BotFiles from "./BotFiles.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Chat from "./connectors/chat/chat.ts";

import * as ServerConfig from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../project/ProjectService.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ChannelHub from "../channels/hub.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Inbox from "../inbox/operations.ts";
import { InboxRuntime } from "../inbox/InboxRuntime.ts";
import * as InboxStore from "../inbox/store.ts";
import { BotRuntime } from "./BotRuntime.ts";
import { followThreads, reconcileThreads } from "./events.ts";
import * as Bots from "./operations.ts";
import { MEMORY_BYTES, parseArgs } from "./tools.ts";
import { BotRejection, BotOperationError } from "./errors.ts";
import { botErrorResponse } from "../http.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as BotStore from "./store.ts";

const isBotRejection = Schema.is(BotRejection);
const isBotOperationError = Schema.is(BotOperationError);

const httpFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flip(effect).pipe(
    Effect.flatMap((error) =>
      Effect.gen(function* () {
        if (!isBotRejection(error) && !isBotOperationError(error)) throw error;
        expect(error).toBeInstanceOf(
          error._tag === "BotRejection" ? BotRejection : BotOperationError,
        );
        const response = HttpServerResponse.toWeb(botErrorResponse(error));
        const body = yield* Effect.promise(
          async () =>
            (await response.json()) as {
              readonly message: string;
              readonly code: string;
              readonly field?: string;
            },
        );
        return {
          status: response.status,
          code: body.code,
          detail: body.message,
          field: body.field,
        };
      }),
    ),
  );

const MODEL = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
const SCRATCH = ProjectId.make("scratch");

interface Harness {
  readonly runtime: BotRuntime["Service"];
  readonly bot: Bots.BotOperations["Service"];
  /** Every packet the bot was sent, launch or send, in order. */
  readonly packets: string[];
  /** Thread id and run id of each turn, in order. */
  readonly runs: Array<{ readonly threadId: string; readonly runId: string }>;
  /** Runs and their assistant replies, as T3 would answer for them. */
  readonly runStatus: Map<string, OrchestrationV2RunStatus>;
  readonly replies: Map<string, string>;
  /** What each run showed with `html_render` (a page) or `send_to_user` (text), in order. */
  readonly pages: Map<
    string,
    Array<{ attachmentId: string; title: string; height: number } | string>
  >;
  /** Thread shells, as reconcile reads them after a restart. */
  readonly shells: Map<string, { latestRunId: string; status: string }>;
  /** Messages typed with the user role in a thread, for the takeover check. */
  readonly userMessages: Map<string, Array<UserMessage>>;
  /** The runtime mode of each launch, and each later switch of one, in order. */
  readonly modes: string[];
  /** Each thread's runtime mode, as its shell reads. */
  readonly threadModes: Map<string, string>;
  /** The model selection of each launch, in order. */
  readonly models: unknown[];
  /** Each non-steer send's mode and whether it asked for a fresh context, in order. */
  readonly sends: Array<{ readonly mode: string; readonly freshContext: boolean }>;
  /** Titles set on threads with a metadata update, in order. */
  readonly titles: Array<{ readonly threadId: string; readonly title: string | undefined }>;
  /** A thread's latest context usage, as its provider reported it. */
  readonly usage: Map<string, { usedTokens: number; maxTokens: number }>;
  /** What T3 answers a steer with: a provider turn to join, or only the queue. */
  steerDelivery: "steered" | "queued";
  /** Projects `thread start` may name, and whether each worker launch saw its thread owned. */
  readonly projects: Array<{ id: string; title: string; workspaceRoot: string }>;
  readonly ownedAtLaunch: boolean[];
  readonly layer: Layer.Layer<HarnessServices>;
}

interface UserMessage {
  readonly createdBy: string;
  readonly createdAt: DateTime.Utc;
  readonly notification?: unknown;
  readonly delegatedCompletion?: unknown;
  readonly idleCompaction?: unknown;
}

type HarnessServices =
  | Bots.BotOperations
  | Inbox.InboxOperations
  | Artifacts.Artifacts
  | BotRuntime
  | ThreadManagement.ThreadManagementService
  | ThreadLaunch.ThreadLaunchService
  | ManagedProjectFolders
  | ProviderRegistry.ProviderRegistry
  | ServerConfig.ServerConfig
  | DocumentText.DocumentText
  | FileSystem.FileSystem
  | Project.ProjectService;

const harness = (providedStore?: BotStore.BotStore["Service"]) =>
  Effect.gen(function* () {
    const store =
      providedStore ?? (yield* BotStore.make(":memory:").pipe(Effect.provide(NodeServices.layer)));
    const botsDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bots-")),
    );
    const runtime: BotRuntime["Service"] = {
      botsDir,
      files: yield* BotFiles.BotFiles.pipe(
        Effect.provide(BotFiles.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
      cliPath: "/bin/t3bot",
      ensureCli: Effect.void,
      ownedThreads: new Map(),
      existingStore: () => store,
      store: Effect.succeed(store),
      active: Latch.makeUnsafe(false),
      turnLock: Semaphore.makeUnsafe(1),
      threadStartLock: Semaphore.makeUnsafe(1),
      workThreads: new Map(
        (yield* store.listBots()).flatMap((bot) =>
          bot.workThreadId === null ? [] : [[bot.workThreadId, bot.id] as const],
        ),
      ),
      activity: new Map(),
      publish: () => undefined,
      publishActivity: (botId, activity) => runtime.activity.set(botId, activity),
      subscribe: () => () => undefined,
    };
    const packets: string[] = [];
    const runs: Array<{ threadId: string; runId: string }> = [];
    const runStatus = new Map<string, OrchestrationV2RunStatus>();
    const replies = new Map<string, string>();
    const pages: Harness["pages"] = new Map();
    const shells = new Map<string, { latestRunId: string; status: string }>();
    const userMessages = new Map<string, Array<UserMessage>>();
    const projects: Harness["projects"] = [];
    const ownedAtLaunch: boolean[] = [];
    const modes: string[] = [];
    const threadModes = new Map<string, string>();
    const models: unknown[] = [];
    const sends: Harness["sends"] = [];
    const titles: Harness["titles"] = [];
    const usage: Harness["usage"] = new Map();
    const nextRun = (threadId: string) => {
      const runId = `run-${runs.length + 1}`;
      runs.push({ threadId, runId });
      runStatus.set(runId, "running");
      return runId;
    };
    const bot = yield* Bots.BotOperations.pipe(
      Effect.provide(Bots.layer.pipe(Layer.provide(Layer.succeed(BotRuntime, runtime)))),
    );
    const layer = Layer.mergeAll(
      Layer.succeed(Bots.BotOperations, bot),
      Layer.mock(Inbox.InboxOperations)({}),
      Artifacts.layer.pipe(Layer.provide(NodeServices.layer)),
      Layer.succeed(BotRuntime, runtime),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadTitles: () => Effect.succeed({}),
        dispatch: (command) => {
          if (command.type === "thread.metadata.update") {
            titles.push({ threadId: command.threadId, title: command.title });
          }
          if (command.type === "thread.runtime-mode.set") {
            modes.push(command.runtimeMode);
            threadModes.set(command.threadId, command.runtimeMode);
          }
          return Effect.succeed({} as never);
        },
        sendToThread: (input) => {
          // No turn is ever mid-provider-turn here, so a steer lands in the queue as T3 would.
          if (input.mode === "steer") {
            return Effect.succeed({ delivery: h.steerDelivery, run: { id: "steer" } } as never);
          }
          packets.push(input.text);
          sends.push({ mode: input.mode, freshContext: input.freshContext === true });
          return Effect.succeed({
            delivery: "queued",
            run: { id: nextRun(input.threadId) },
          } as never);
        },
        getThreadShell: (threadId) => {
          const shell = shells.get(threadId);
          const runtimeMode = threadModes.get(threadId);
          if (shell === undefined && runtimeMode === undefined)
            return Effect.fail("missing" as never);
          return Effect.succeed({ ...shell, runtimeMode, pendingRuntimeRequest: null } as never);
        },
        getProjectThreadRecords: (input, _fields, filter) =>
          Effect.succeed({
            thread: { activeProviderThreadId: "pt" },
            providerTurns: usage.has(input.threadId)
              ? [
                  {
                    providerThreadId: "pt",
                    tokenUsage: { ...usage.get(input.threadId), updatedAt: "2026-01-01T00:00:00Z" },
                  },
                ]
              : [],
            runs: (filter?.runIds ?? []).flatMap((id) =>
              runStatus.has(id) ? [{ id, status: runStatus.get(id) }] : [],
            ),
            messages:
              filter?.messageRunIds === undefined
                ? (userMessages.get(input.threadId) ?? [])
                : filter.messageRunIds.flatMap((id) =>
                    replies.has(id)
                      ? [{ text: replies.get(id), createdAt: DateTime.makeUnsafe(0) }]
                      : [],
                  ),
            turnItems: (pages.get(filter?.turnItemRunId ?? "") ?? []).map((shown, ordinal) =>
              typeof shown === "string"
                ? {
                    id: `sent-${ordinal}`,
                    ordinal,
                    type: "dynamic_tool",
                    status: "completed",
                    toolName: "mcp__t3-code__send_to_user",
                    output: { sentMessage: shown },
                  }
                : {
                    id: `page-${ordinal}`,
                    ordinal,
                    type: "dynamic_tool",
                    status: "completed",
                    toolName: "mcp__t3-code__html_render",
                    output: { structuredContent: { htmlRender: shown }, content: [] },
                  },
            ),
          } as never),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          if (input.projectId !== SCRATCH) {
            ownedAtLaunch.push(runtime.ownedThreads.has(input.threadId!));
            if (input.initialMessage?.text === "fail")
              return Effect.fail({ message: "no" } as never);
          }
          packets.push(input.initialMessage?.text ?? "");
          modes.push(input.runtimeMode);
          threadModes.set(input.threadId!, input.runtimeMode);
          models.push(input.modelSelection);
          const runId = nextRun(input.threadId!);
          return Effect.succeed({
            threadId: input.threadId,
            projection: { runs: [{ id: runId, userMessageId: input.initialMessage?.messageId }] },
          } as never);
        },
      }),
      Layer.mock(ManagedProjectFolders)({
        namedProjectsRoot: botsDir,
        ensureScratchProject: Effect.succeed({ projectId: SCRATCH }),
      }),
      Layer.mock(DocumentText.DocumentText)({}),
      Layer.mock(Project.ProjectService)({ listShells: () => Effect.succeed(projects as never) }),
      // The model's provider, like Antigravity, offers every mode but auto.
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([
          {
            instanceId: MODEL.instanceId,
            supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          },
          { instanceId: "codex", supportedRuntimeModes: ["auto", "full-access"] },
        ] as never),
      }),
      Layer.succeed(ServerConfig.ServerConfig, {} as never),
      FileSystem.layerNoop({}),
    );
    const h: Harness = {
      bot,
      runtime,
      packets,
      runs,
      runStatus,
      replies,
      pages,
      shells,
      userMessages,
      steerDelivery: "queued",
      sends,
      titles,
      usage,
      projects,
      ownedAtLaunch,
      modes,
      threadModes,
      models,
      layer,
    };
    return h;
  });

const chatOf = Effect.fn("Test.chatOf")(function* (h: Harness, botId: string) {
  return (yield* h.runtime.existingStore()!.recentChat(botId, 100)).map((message) => [
    message.role,
    message.text,
  ]);
});

/** T3 ends the run with this reply, as the domain event follower would report it. */
const endRun = (h: Harness, botId: string, index: number, reply: string | null) => {
  const { runId } = h.runs[index]!;
  h.runStatus.set(runId, "completed");
  if (reply !== null) h.replies.set(runId, reply);
  return h.bot.finishRun(botId, runId, "completed");
};

const withHarness = <E>(
  program: (h: Harness) => Effect.Effect<void, E, HarnessServices>,
  store?: BotStore.BotStore["Service"],
) =>
  harness(store).pipe(
    Effect.flatMap((h) =>
      program(h).pipe(
        Effect.provide(h.layer),
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(h.runtime.botsDir, { recursive: true, force: true })),
        ),
      ),
    ),
  );

/** The harness plus the inbox, with the built-in example channel switched on. */
const withChat = <E>(
  program: (h: Harness) => Effect.Effect<void, E, HarnessServices | InboxRuntime>,
) =>
  withHarness((h) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bot-chat-")),
        );
        const hub = yield* ChannelHub.make({
          // Adapter fixtures stay independent of the bot scheduling clock.
          now: () => 1_795_824_000_000,
          configPath: NodePath.join(dir, "channels.json"),
          background: false,
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)));
        yield* Effect.gen(function* () {
          yield* hub.start();
          const example = hub.list().find((channel) => channel.id === "example")!;
          yield* hub.save(
            {
              id: example.id,
              kind: example.kind,
              name: example.name,
              baseUrl: example.baseUrl,
              tokenFile: example.tokenFile,
              enabled: true,
            },
            { create: false },
          );
        });
        const inbox = yield* InboxStore.make(":memory:").pipe(Effect.provide(NodeServices.layer));
        yield* program(h).pipe(
          Effect.provide(Inbox.layer),
          Effect.provideService(InboxRuntime, {
            hub,
            store: inbox,
            channelsDir: dir,
            itemsDir: NodePath.join(dir, "items"),
            subscribe: (listener) => hub.subscribe(listener),
          }),
          Effect.ensuring(Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }))),
        );
      }),
    ),
  );

describe("bot creation", () => {
  it.effect("starts a turn with the brief as its first chat message", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const brief = "Watch for new releases.\nAsk me before merging.";
        const { botId } = yield* h.bot.createBot({
          name: "Release Watcher",
          modelSelection: MODEL,
          brief: `  ${brief}\n`,
        });

        expect(yield* chatOf(h, botId)).toEqual([["user", brief]]);
        expect(h.runs).toHaveLength(1);
        expect(h.packets[0]).toContain(brief);

        yield* endRun(h, botId, 0, "I'll watch for new releases.");

        expect(h.runs).toHaveLength(1);
        expect(yield* chatOf(h, botId)).toEqual([
          ["user", brief],
          ["bot", "I'll watch for new releases."],
        ]);
      }),
    ),
  );

  it.effect("creates an idle bot when the brief is omitted, null, or blank", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        for (const optional of [{}, { brief: null }, { brief: " \n\t " }]) {
          const { botId } = yield* h.bot.createBot({
            name: "Bot",
            modelSelection: MODEL,
            ...optional,
          });
          expect(yield* chatOf(h, botId)).toEqual([]);
        }
        expect(h.runs).toEqual([]);
      }),
    ),
  );

  it.effect("rejects an overlong brief before creating a bot or its files", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const error = yield* httpFailure(
          h.bot.createBot({ name: "Bot", modelSelection: MODEL, brief: "x".repeat(20_001) }),
        );

        expect(error).toMatchObject({ status: 400, code: "bad_request", field: "brief" });
        expect(yield* h.runtime.existingStore()!.listBots()).toEqual([]);
        expect(yield* Effect.promise(() => NodeFSP.readdir(h.runtime.botsDir))).toEqual([]);
        expect(h.runtime.active.isOpen()).toBe(false);
        expect(h.runs).toEqual([]);
      }),
    ),
  );
});

describe("bot turns", () => {
  it.effect("answers each message in one turn at a time, in its one work thread", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({
          name: "Release Watcher",
          modelSelection: MODEL,
        });
        yield* h.bot.saveRole({ botId, role: "Keep fork releases healthy." });

        yield* h.bot.sendMessage({ botId, text: "What do you do?" });
        // A second message while the turn runs waits for it.
        yield* h.bot.sendMessage({ botId, text: "And how often?" });
        expect(h.runs).toHaveLength(1);
        expect(h.packets[0]).toContain("Keep fork releases healthy.");
        expect(h.packets[0]).toContain("What do you do?");

        yield* endRun(h, botId, 0, "I watch the fork's releases.");
        expect(h.runs).toHaveLength(2);
        expect(h.runs[1]!.threadId).toBe(h.runs[0]!.threadId);
        // The session holds the first turn, so the next carries only the waiting message.
        expect(h.packets[1]).toContain("And how often?");
        expect(h.packets[1]).not.toContain("What do you do?");
        expect(h.packets[1]).not.toContain("Keep fork releases healthy.");

        yield* endRun(h, botId, 1, null);
        expect(yield* chatOf(h, botId)).toEqual([
          ["user", "What do you do?"],
          ["user", "And how often?"],
          ["bot", "I watch the fork's releases."],
          ["error", "The turn ended without a reply."],
        ]);
        expect(yield* h.runtime.existingStore()!.getTurn(botId)).toBeNull();
        // Its posts count as unread on the Bots entry until the user sees its chat.
        const unread = () => h.bot.listBots().pipe(Effect.map(({ bots }) => bots[0]!.unread));
        expect(yield* unread()).toBe(2);
        yield* h.bot.markSeen({ botId });
        expect(yield* unread()).toBe(0);

        // A failed turn may have lost what it was sent, so the one after resends it all.
        yield* h.bot.sendMessage({ botId, text: "Still there?" });
        yield* h.bot.finishRun(botId, h.runs[2]!.runId, "failed");
        yield* h.bot.sendMessage({ botId, text: "Hello?" });
        expect(h.packets[3]).toContain("Keep fork releases healthy.");
      }),
    ),
  );

  it.effect(
    "keeps a dispatch store failure as a defect instead of reporting a successful send",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
          const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
          using _prepare = vi
            .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
            .mockImplementation(function (this: NodeSqlite.DatabaseSync, sql) {
              if (sql === "UPDATE bots SET work_thread_id = ?, work_project_id = ? WHERE id = ?")
                throw new Error("write failed");
              return prepare.call(this, sql);
            });
          const exit = yield* Effect.exit(h.bot.sendMessage({ botId, text: "Start." }));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(yield* chatOf(h, botId)).toEqual([["user", "Start."]]);
          expect(yield* h.runtime.existingStore()!.getTurn(botId)).toBeNull();
        }),
      ),
  );

  it.effect("finishes a turn whose run ended while the server was down, once", () =>
    Effect.gen(function* () {
      const store = yield* BotStore.make(":memory:");
      yield* store.createBot(
        { id: "bot_1", name: "Bot", modelSelection: MODEL as never, createdAt: "t0" },
        "auto",
      );
      yield* store.setWorkThread("bot_1", "thread-1", SCRATCH);
      yield* store.addChat({ id: "m1", botId: "bot_1", role: "user", text: "Hi", createdAt: "t1" });
      yield* store.startTurn(
        { botId: "bot_1", runId: "run-down", threadId: "thread-1", startedAt: "t1" },
        ["m1"],
        [],
      );
      yield* withHarness(
        (h) =>
          Effect.gen(function* () {
            h.runStatus.set("run-down", "completed");
            h.replies.set("run-down", "Hello.");
            yield* h.bot.reconcile();
            // The event for the same run, arriving late, posts nothing more.
            yield* h.bot.finishRun("bot_1", "run-down", "completed");
            expect(yield* chatOf(h, "bot_1")).toEqual([
              ["user", "Hi"],
              ["bot", "Hello."],
            ]);
            expect(h.runs).toHaveLength(0);
          }),
        store,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "fires a routine missed while down once, saying it is late, then sets the next time",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
          const store = h.runtime.existingStore()!;
          const id = yield* store.addRoutine(botId, {
            title: "PR check",
            prompt: "Check open PRs.",
            schedule: { type: "daily", time: "09:00" },
            // Missed on three mornings while the server was down.
            nextDueAt: new Date(2026, 10, 20, 9, 0).toISOString(),
          });
          yield* h.bot.fireDueRoutines(DateTime.makeZonedUnsafe(new Date(2026, 10, 23, 11, 40)));
          expect(h.runs).toHaveLength(1);
          expect(h.packets[0]).toContain(
            'Routine 1 "PR check" is due. It was due at 09:00 and starts late, at 11:40.',
          );
          expect(
            (yield* store.listRoutines(botId)).find((routine) => routine.id === id)?.nextDueAt,
          ).toBe(new Date(2026, 10, 24, 9, 0).toISOString());
          // A turn with nothing worth telling ends with NO_REPLY and posts nothing.
          yield* endRun(h, botId, 0, Bots.NO_REPLY);
          expect(yield* chatOf(h, botId)).toEqual([]);
        }),
      ),
  );

  it.effect("queues a thread's end for the bot and wakes it only as its follow-up says", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const store = h.runtime.existingStore()!;
        for (const [threadId, follow] of [
          ["t-attention", "attention"],
          ["t-now", "now"],
        ] as const) {
          yield* store.addThread({
            threadId,
            botId,
            projectId: "p",
            itemId: null,
            follow,
            createdAt: "t0",
          });
          h.runtime.ownedThreads.set(threadId, botId);
        }
        const ended = (threadId: string, status: string) =>
          ({ type: "run.updated", threadId, payload: { id: `${threadId}-run`, status } }) as never;
        // A finished attention thread waits for the next turn; repeated updates queue it once.
        yield* followThreads(
          Stream.make(ended("t-attention", "completed"), ended("t-attention", "completed")),
        );
        expect(h.runs).toHaveLength(0);
        expect((yield* store.queued(botId)).map((event) => event.wakes)).toEqual([false]);
        // A finished now thread wakes the bot, and that turn takes both events.
        h.replies.set("t-now-run", "Found it:\nthe cache was stale.");
        yield* followThreads(Stream.make(ended("t-now", "completed")));
        expect(h.runs).toHaveLength(1);
        expect(h.packets[0]).toContain("Thread t-attention completed. It left no message");
        // Its last message comes along, so the bot need not read the thread to pass it on.
        expect(h.packets[0]).toContain(
          "Thread t-now completed. Its last message:\n  > Found it:\n  > the cache was stale.",
        );
        expect(yield* store.queued(botId)).toEqual([]);
      }),
    ),
  );

  it.effect("posts what the bot says instead of its last message, and caps memory", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        yield* h.bot.sendMessage({ botId, text: "Remember my timezone." });
        yield* h.bot.runTool({
          bot: botId,
          argv: ["memory", "add", "The user is in UTC+8."],
          stdin: "",
        });
        const full = yield* httpFailure(
          h.bot.runTool({
            bot: botId,
            argv: ["memory", "add", "x".repeat(MEMORY_BYTES)],
            stdin: "",
          }),
        );
        expect(full.detail).toContain("Merge or remove notes first");
        yield* h.bot.runTool({ bot: botId, argv: ["say", "Noted: UTC+8."], stdin: "" });
        yield* endRun(h, botId, 0, "I saved it with memory add and replied.");
        expect(yield* chatOf(h, botId)).toEqual([
          ["user", "Remember my timezone."],
          ["bot", "Noted: UTC+8."],
        ]);
        expect(
          (yield* h.runtime.existingStore()!.listMemory(botId)).map((note) => note.text),
        ).toEqual(["The user is in UTC+8."]);
      }),
    ),
  );

  it.effect("posts the pages its work thread showed with its reply, each once", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const page = (id: string) => ({ attachmentId: id, title: `Map ${id}`, height: 400 });
        const rendersOf = Effect.fn("Test.rendersOf")(function* () {
          return (yield* h.runtime.existingStore()!.recentChat(botId, 100)).map(
            (message) => message.renders?.map((render) => render.attachmentId) ?? [],
          );
        });

        yield* h.bot.sendMessage({ botId, text: "Draw the map." });
        h.pages.set(h.runs[0]!.runId, [page("a")]);
        yield* h.bot.runTool({ bot: botId, argv: ["say", "Here it is."], stdin: "" });
        h.pages.set(h.runs[0]!.runId, [page("a"), page("b")]);
        yield* endRun(h, botId, 0, null);

        yield* h.bot.sendMessage({ botId, text: "Again, plainly." });
        h.pages.set(h.runs[1]!.runId, [page("c")]);
        yield* endRun(h, botId, 1, "Redrawn.");

        expect(yield* chatOf(h, botId)).toEqual([
          ["user", "Draw the map."],
          ["bot", "Here it is."],
          ["bot", ""],
          ["user", "Again, plainly."],
          ["bot", "Redrawn."],
        ]);
        expect(yield* rendersOf()).toEqual([[], ["a"], ["b"], [], ["c"]]);
      }),
    ),
  );

  it.effect("posts what the work thread sent the user, a page with the text after it", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const page = { attachmentId: "p", title: "Plan", height: 400 };
        yield* h.bot.sendMessage({ botId, text: "Show me, then wait." });
        h.pages.set(h.runs[0]!.runId, [page, "Here is the plan.", "Reply when ready."]);
        yield* h.bot.runTool({ bot: botId, argv: ["say", "Waiting."], stdin: "" });
        yield* endRun(h, botId, 0, null);

        const chat = yield* h.runtime.existingStore()!.recentChat(botId, 100);
        expect(chat.map((message) => [message.role, message.text])).toEqual([
          ["user", "Show me, then wait."],
          ["bot", "Here is the plan."],
          ["bot", "Reply when ready."],
          ["bot", "Waiting."],
        ]);
        expect(chat[1]!.renders?.map((render) => render.attachmentId)).toEqual(["p"]);
      }),
    ),
  );

  it.effect("counts a sent message as the reply a user message is owed", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        yield* h.bot.sendMessage({ botId, text: "Ping." });
        h.pages.set(h.runs[0]!.runId, ["Pong."]);
        yield* endRun(h, botId, 0, null);
        expect(yield* chatOf(h, botId)).toEqual([
          ["user", "Ping."],
          ["bot", "Pong."],
        ]);
      }),
    ),
  );

  it.effect(
    "asks before a gated action, runs exactly that call once approved, and lets it lapse",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
          const store = h.runtime.existingStore()!;
          const roleOf = () =>
            NodeFSP.readFile(NodePath.join(h.runtime.botsDir, botId, "role.md"), "utf8");
          const edit = (role: string) =>
            h.bot.runTool({ bot: botId, argv: ["role", "edit", "-"], stdin: role });

          // Editing its role asks by default: nothing changes until the user approves.
          expect(yield* edit("Watch CI.")).toContain("the user must approve");
          const [question] = yield* store.openQuestions(botId);
          expect(question).toMatchObject({
            createdAt: "1970-01-01T00:00:00.000Z",
            expiresAt: "1970-01-02T00:00:00.000Z",
          });
          expect(question?.text).toContain("Watch CI.");
          expect(yield* Effect.promise(() => roleOf().catch(() => ""))).toBe("");
          // The sidebar shows a waiting question apart from unread posts.
          const counts = () =>
            h.bot.listBots().pipe(
              Effect.map(({ bots }) => ({
                questions: bots[0]!.questions,
                unread: bots[0]!.unread,
              })),
            );
          expect(yield* counts()).toEqual({ questions: 1, unread: 0 });
          yield* h.bot.answerQuestion({ botId, questionId: question!.id, approve: true });
          expect((yield* counts()).questions).toBe(0);
          expect(yield* Effect.promise(roleOf)).toBe("Watch CI.");
          // The answer wakes the bot.
          expect(h.packets.at(-1)).toContain(
            "approved your question 1, and it ran: Role replaced.",
          );
          // A question is answered once.
          const again = yield* httpFailure(
            h.bot.answerQuestion({ botId, questionId: question!.id, approve: true }),
          );
          expect(again.code).toBe("question_closed");

          // Unanswered, it lapses after a day and its action never runs.
          yield* edit("Watch nothing.");
          yield* TestClock.adjust(86_400_000 - 1);
          yield* h.bot.fireDueRoutines();
          expect(yield* store.openQuestions(botId)).toHaveLength(1);
          yield* TestClock.adjust(1);
          yield* h.bot.fireDueRoutines();
          expect(yield* store.openQuestions(botId)).toEqual([]);
          expect((yield* store.queued(botId)).at(-1)?.text).toContain("lapsed unanswered");
          expect(yield* Effect.promise(roleOf)).toBe("Watch CI.");
        }),
      ),
  );

  it.effect("returns the workspace before a bot has a work thread", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Files", modelSelection: MODEL });
        const detail = yield* h.bot.readBot(new URLSearchParams({ botId }));
        expect(detail.bot.workThreadId).toBeNull();
        expect(detail.workspacePath).toBe(NodePath.join(h.runtime.botsDir, botId, "workspace"));
        expect(detail.notesPath).toBe(NodePath.join(detail.workspacePath, "notes"));
      }),
    ),
  );

  it.effect("holds turns while paused and past the day's budget, saying so once", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const read = () => h.bot.readBot(new URLSearchParams({ botId }));
        expect((yield* read()).bot.settings.turnsPerDay).toBe(200);
        yield* h.bot.setPaused({ botId, paused: true });
        yield* h.bot.sendMessage({ botId, text: "Hi" });
        expect(h.runs).toHaveLength(0);
        yield* h.bot.setPaused({ botId, paused: false });
        expect(h.runs).toHaveLength(1);

        yield* h.bot.saveSettings({
          botId,
          settings: { turnsPerDay: 1, maxThreads: 3 },
        });
        yield* endRun(h, botId, 0, "Hello.");
        yield* h.bot.sendMessage({ botId, text: "Still there?" });
        yield* h.bot.sendMessage({ botId, text: "Hello?" });
        expect(h.runs).toHaveLength(1);
        expect((yield* chatOf(h, botId)).filter(([role]) => role === "error")).toEqual([
          [
            "error",
            "Bot used its 1 turns for today. What happens meanwhile waits for tomorrow, or raise its budget.",
          ],
        ]);
        expect((yield* read()).bot.turnsToday).toBe(1);

        // One more turn a day lets the held messages run now.
        yield* h.bot.saveSettings({
          botId,
          settings: { turnsPerDay: 2, maxThreads: 3 },
        });
        expect(h.runs).toHaveLength(2);
        expect((yield* read()).bot.turnsToday).toBe(2);

        yield* endRun(h, botId, 1, "Done for today.");
        yield* TestClock.adjust("24 hours");
        expect((yield* read()).bot.turnsToday).toBe(0);
        yield* h.bot.sendMessage({ botId, text: "A new day" });
        expect(h.runs).toHaveLength(3);
        expect((yield* read()).bot.turnsToday).toBe(1);

        // A count left from an earlier day reads as none used today.
        yield* h.runtime.existingStore()!.countTurn(botId, "2000-01-01");
        expect((yield* read()).bot.turnsToday).toBe(0);
      }),
    ),
  );

  it.effect("shows the latest line of its work thread while a turn runs", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        yield* h.bot.sendMessage({ botId, text: "Clean up" });
        const threadId = (yield* h.runtime.existingStore()!.getBot(botId))!.workThreadId!;
        const runId = h.runs[0]!.runId;
        const item = (fields: Record<string, unknown>) =>
          ({ type: "turn-item.updated", threadId, payload: { runId, ...fields } }) as never;
        const read = () => h.bot.readBot(new URLSearchParams({ botId }));

        // Streamed text and NO_REPLY leave the line alone.
        yield* followThreads(
          Stream.make(
            item({ type: "assistant_message", streaming: true, text: "Half a thou" }),
            item({
              type: "assistant_message",
              streaming: false,
              text: "\n## Checking   the branch\nthen more",
            }),
            item({ type: "assistant_message", streaming: false, text: "NO_REPLY" }),
          ),
        );
        expect((yield* read()).activity).toEqual({ text: "Checking the branch", threadId });

        // A tool call shows as it starts, once; its output never reaches the line.
        const command = (status: string, output?: string) =>
          item({
            id: "item-1",
            type: "command_execution",
            status,
            input: "git status\n--short",
            ...(output === undefined ? {} : { output }),
          });
        yield* followThreads(Stream.make(command("running"), command("running", "M a.ts")));
        expect((yield* read()).activity).toEqual({ text: "git status", threadId });

        // The line belongs to the work: once it ends there is none.
        yield* endRun(h, botId, 0, "Done.");
        expect((yield* read()).workingSince).toBeNull();
        expect((yield* read()).activity).toBeNull();
      }),
    ),
  );

  it.effect("stays working from the ask to the answer while a thread it follows now runs", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const store = h.runtime.existingStore()!;
        const read = () => h.bot.readBot(new URLSearchParams({ botId }));
        yield* h.bot.sendMessage({ botId, text: "Find old backups" });
        const since = (yield* read()).workingSince;
        expect(since).not.toBeNull();

        // The turn hands the work to a thread and ends without a word.
        for (const [threadId, follow] of [
          ["t-now", "now"],
          ["t-attention", "attention"],
        ] as const) {
          yield* store.addThread({
            threadId,
            botId,
            projectId: "p",
            itemId: null,
            follow,
            createdAt: "t0",
          });
          h.runtime.ownedThreads.set(threadId, botId);
        }
        yield* endRun(h, botId, 0, "NO_REPLY");
        expect((yield* chatOf(h, botId)).filter(([role]) => role !== "user")).toEqual([]);
        expect((yield* read()).workingSince).toBe(since);
        expect((yield* h.bot.listBots()).bots[0]!.working).toBe(true);

        // Its progress is the chat's line; a thread followed only on attention gives none.
        const said = (threadId: string, text: string) =>
          ({
            type: "turn-item.updated",
            threadId,
            payload: {
              runId: `${threadId}-run`,
              type: "assistant_message",
              streaming: false,
              text,
            },
          }) as never;
        yield* followThreads(
          Stream.make(said("t-now", "Scanning /home"), said("t-attention", "Elsewhere")),
        );
        expect((yield* read()).activity).toEqual({ text: "Scanning /home", threadId: "t-now" });

        // Its end wakes the bot, which takes up the answer in the same span.
        h.replies.set("t-now-run", "Found 3 GB.");
        yield* followThreads(
          Stream.make({
            type: "run.updated",
            threadId: "t-now",
            payload: { id: "t-now-run", status: "completed" },
          } as never),
        );
        expect(h.runs).toHaveLength(2);
        expect((yield* read()).workingSince).toBe(since);
        yield* endRun(h, botId, 1, "3 GB of old backups.");
        expect((yield* read()).workingSince).toBeNull();
        expect((yield* read()).activity).toBeNull();
      }),
    ),
  );

  it.effect("runs its work thread in the mode the user picks, and switches it on a change", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        // No pick: the broadest the provider offers up to auto, which it lacks.
        const unpicked = yield* h.bot.createBot({ name: "Default", modelSelection: MODEL });
        expect(
          (yield* h.runtime.existingStore()!.getBot(unpicked.botId))?.settings.runtimeMode,
        ).toBe("auto-accept-edits");
        const { botId } = yield* h.bot.createBot({
          name: "Ops",
          modelSelection: MODEL,
          runtimeMode: "full-access",
        });
        yield* h.bot.sendMessage({ botId, text: "Hi" });
        yield* h.bot.saveSettings({
          botId,
          settings: { turnsPerDay: 100, maxThreads: 3, runtimeMode: "auto" },
        });
        expect(h.modes).toEqual(["full-access", "auto-accept-edits"]);
        expect((yield* h.runtime.existingStore()!.getBot(botId))?.settings.runtimeMode).toBe(
          "auto",
        );

        // Sending from the thread's composer set its own mode; the next turn restores the bot's.
        const threadId = (yield* h.runtime.existingStore()!.getBot(botId))!.workThreadId!;
        h.threadModes.set(threadId, "full-access");
        yield* endRun(h, botId, h.runs.length - 1, "Hello");
        yield* h.bot.sendMessage({ botId, text: "Again" });
        expect(h.threadModes.get(threadId)).toBe("auto-accept-edits");
      }),
    ),
  );

  it.effect("delays mention wakes by 30 seconds on the Effect clock", () =>
    withChat((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Mentions", modelSelection: MODEL });
        yield* h.bot.saveSettings({
          botId,
          settings: {
            turnsPerDay: 100,
            maxThreads: 3,
            connectors: {
              example: { enabled: true, permissions: { send: "ask" }, config: { mentions: true } },
            },
          },
        });
        yield* Chat.scanMentions("example");
        const pending = (yield* h.runtime.existingStore()!.listMentions("example")).filter(
          (mark) => mark.dueAt !== null,
        );
        expect(pending.length).toBeGreaterThan(0);
        expect(pending.every((mark) => mark.dueAt === "1970-01-01T00:00:30.000Z")).toBe(true);
        yield* TestClock.adjust(29_999);
        yield* Chat.fireDueMentions();
        expect(h.runs).toHaveLength(0);
        yield* TestClock.adjust(1);
        yield* Chat.fireDueMentions();
        expect(h.runs).toHaveLength(1);
        expect(
          (yield* h.runtime.existingStore()!.listMentions("example")).every(
            (mark) => mark.dueAt === null,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect(
    "gives one bot per channel the user's mentions, and none while the channel is off",
    () =>
      withChat((h) =>
        Effect.gen(function* () {
          const store = h.runtime.existingStore()!;
          const first = yield* h.bot.createBot({ name: "Inbox", modelSelection: MODEL });
          const second = yield* h.bot.createBot({ name: "Other", modelSelection: MODEL });
          const save = (botId: string, enabled: boolean, mentions: boolean) =>
            h.bot.saveSettings({
              botId,
              settings: {
                turnsPerDay: 100,
                maxThreads: 3,
                connectors: {
                  example: { enabled, permissions: { send: "ask" }, config: { mentions } },
                },
              },
            });
          const example = Effect.fn("Test.example")(function* (botId: string) {
            return (yield* store.getBot(botId))!.settings.connectors.example;
          });
          expect(yield* example(first.botId)).toBeUndefined();

          yield* save(first.botId, true, true);
          const since = (yield* example(first.botId))?.config.mentionsSince;
          expect(since).toEqual(expect.any(String));
          // Saving again keeps when it took mentions on.
          yield* save(first.botId, true, true);
          expect((yield* example(first.botId))?.config.mentionsSince).toBe(since);

          yield* save(second.botId, true, true);
          expect((yield* example(first.botId))?.config.mentions).toBe(false);
          expect((yield* example(second.botId))?.config.mentions).toBe(true);

          yield* save(second.botId, false, true);
          expect((yield* example(second.botId))?.config.mentions).toBe(false);

          const unknown = yield* httpFailure(
            h.bot.saveSettings({
              botId: first.botId,
              settings: {
                turnsPerDay: 100,
                maxThreads: 3,
                connectors: { lark: { enabled: true } },
              },
            }),
          );
          expect(unknown.detail).toBe('No connector "lark" here.');
        }),
      ),
  );

  it.effect("keeps legacy chat settings and drops obsolete thread permissions", () =>
    Effect.gen(function* () {
      const store = yield* BotStore.make(":memory:");
      yield* store.createBot(
        { id: "bot_1", name: "Old", modelSelection: MODEL as never, createdAt: "2026-11-01" },
        "auto",
      );
      yield* store.setSettings("bot_1", {
        threads: "ask",
        channelsEnabled: true,
        signature: "-- {bot}",
        channels: { lark: { send: "allow", mentions: true, mentionsSince: "2026-11-02" } },
      } as never);
      const settings = (yield* store.getBot("bot_1"))!.settings;
      expect(settings).not.toHaveProperty("threads");
      expect(settings.turnsPerDay).toBe(200);
      expect(settings.connectors).toEqual({
        lark: {
          enabled: true,
          permissions: { send: "allow" },
          config: { signature: "-- {bot}", mentions: true, mentionsSince: "2026-11-02" },
        },
      });
      yield* store.setSettings("bot_1", {
        permissions: { "thread.start": "deny", "thread.send": "allow" },
      } as never);
      expect((yield* store.getBot("bot_1"))!.settings).not.toHaveProperty("threads");
      yield* store.close();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("offers no chat where the environment has no chat channel", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        expect(yield* h.bot.runTool({ bot: botId, argv: ["help"], stdin: "" })).not.toContain(
          "send <conversation>",
        );
        const refused = yield* httpFailure(
          h.bot.runTool({ bot: botId, argv: ["chat", "unread"], stdin: "" }),
        );
        expect(refused.detail).toBe(
          "No chat channel is on for you; the user can turn one on in your settings.",
        );
        const unknown = yield* httpFailure(
          h.bot.runTool({ bot: botId, argv: ["example", "unread"], stdin: "" }),
        );
        expect(unknown.detail).toBe('Unknown command "example". Run help.');
      }),
    ),
  );

  it.effect("names each chat channel as its own command, and gates every send", () =>
    withChat((h) =>
      Effect.gen(function* () {
        const store = h.runtime.existingStore()!;
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const tool = (...argv: string[]) => h.bot.runTool({ bot: botId, argv, stdin: "" });
        const save = (enabled: boolean, send: "allow" | "ask", signature = "") =>
          h.bot.saveSettings({
            botId,
            settings: {
              turnsPerDay: 100,
              maxThreads: 3,
              connectors: { example: { enabled, permissions: { send }, config: { signature } } },
            },
          });

        expect((yield* httpFailure(tool("example", "unread"))).detail).toBe(
          "Example is off for you; the user can turn it on in your settings.",
        );
        yield* save(true, "ask", "-- {bot}");
        const help = yield* tool("help");
        expect(help).toContain("example send <conversation>");
        expect((yield* httpFailure(tool("chat", "unread"))).detail).toContain(
          "`example …` for Example",
        );
        expect(yield* tool("example", "list")).toContain('c-dm-jordan "Jordan Lee"');

        // Asking stores the call; nothing reaches the channel until the user approves it.
        const asked = yield* tool("example", "send", "c-dm-jordan", "On", "it");
        expect(asked).toContain("the user must approve this");
        const [question] = yield* store.openQuestions(botId);
        expect(question?.text).toBe('Example: send as you to "Jordan Lee"\n\nOn it\n\n-- Bot');
        expect(yield* tool("example", "read", "c-dm-jordan")).not.toContain("On it");
        const approved = yield* h.bot.answerQuestion({
          botId,
          questionId: question!.id,
          approve: true,
        });
        expect(approved.ok).toBe(true);
        expect(yield* tool("example", "read", "c-dm-jordan")).toContain("On it");

        // Approval resolves the call again: a channel turned off since runs nothing.
        yield* tool("example", "send", "c-dm-jordan", "Later");
        const [later] = yield* store.openQuestions(botId);
        yield* save(false, "ask");
        const lapsed = yield* h.bot.answerQuestion({ botId, questionId: later!.id, approve: true });
        expect(lapsed).toEqual({
          ok: false,
          output: "Example is off for you; the user can turn it on in your settings.",
        });

        yield* save(true, "allow");
        expect(yield* tool("example", "send", "Jordan Lee", "Sent", "now")).toContain(
          'Sent as the user to "Jordan Lee"',
        );
      }),
    ),
  );

  it.effect("joins a message to the running turn when T3 steers it in", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        yield* h.bot.sendMessage({ botId, text: "Start." });
        h.steerDelivery = "steered";
        const { messageId } = yield* h.bot.sendMessage({ botId, text: "Also this." });
        const steered = (yield* h.runtime.existingStore()!.recentChat(botId, 10)).find(
          (message) => message.id === messageId,
        );
        expect(steered?.turnRunId).toBe(h.runs[0]!.runId);
        // Nothing waits, so the end of the turn starts no other.
        yield* endRun(h, botId, 0, "Done both.");
        expect(h.runs).toHaveLength(1);
      }),
    ),
  );

  it.effect("owns a thread before it launches, and lets it go when the launch fails", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const ownModel = { ...MODEL, options: [{ id: "effort", value: "medium" }] };
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: ownModel });
        const store = h.runtime.existingStore()!;
        const legacySettings = { ...(yield* store.getBot(botId))!.settings, threads: "ask" };
        yield* store.setSettings(botId, legacySettings);
        h.projects.push({ id: "p1", title: "Repo", workspaceRoot: "/repo" });
        const start = (prompt: string) =>
          h.bot.runTool({
            bot: botId,
            argv: ["thread", "start", "--project=Repo", "--follow", "now", prompt],
            stdin: "",
          });
        expect(yield* start("Fix --flaky tests")).toContain("started in Repo");
        expect(h.ownedAtLaunch).toEqual([true]);
        const [owned] = yield* store.listThreads(botId);
        expect(owned?.follow).toBe("now");
        expect(h.packets.at(-1)).toBe("Fix --flaky tests");
        // Its own model, so its own effort rather than the provider's default.
        expect(h.models.at(-1)).toEqual(ownModel);

        const failed = yield* httpFailure(start("fail"));
        expect(failed.detail).toContain("did not start");
        expect(yield* store.listThreads(botId)).toHaveLength(1);
        expect(h.runtime.ownedThreads.size).toBe(1);

        yield* h.bot.saveSettings({
          botId,
          settings: { turnsPerDay: 200, maxThreads: 1, threads: "retired value" },
        });
        expect(yield* start("Another task")).toContain("the user must approve this");
        expect((yield* store.openQuestions(botId)).map((question) => question.text)).toEqual([
          "start a thread in Repo (1 of its 1 threads already run)\n\nAnother task",
        ]);
        expect(yield* store.listThreads(botId)).toHaveLength(1);
      }),
    ),
  );

  it.effect("tells the bot when a thread's context fills, and sends fresh on --fresh", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const store = h.runtime.existingStore()!;
        const legacySettings = { ...(yield* store.getBot(botId))!.settings, threads: "ask" };
        yield* store.setSettings(botId, legacySettings);
        yield* store.addThread({
          threadId: "t1",
          botId,
          projectId: "p",
          itemId: null,
          follow: "now",
          createdAt: "t0",
        });
        h.shells.set("t1", { latestRunId: "r", status: "idle" });
        const tool = (...argv: string[]) => h.bot.runTool({ bot: botId, argv, stdin: "" });

        expect(yield* tool("thread", "read", "t1")).toContain("does not report context size");
        h.usage.set("t1", { usedTokens: 50_000, maxTokens: 200_000 });
        expect(yield* tool("thread", "send", "t1", "Next")).toBe("Sent (queued).");
        h.usage.set("t1", { usedTokens: 150_000, maxTokens: 200_000 });
        expect(yield* tool("thread", "read", "t1")).toContain("(75%). Give it more work with");
        expect(yield* tool("thread", "send", "t1", "Next")).toContain("--fresh");

        expect(yield* tool("thread", "send", "--fresh", "t1", "Goal: ship it")).toContain(
          "on a clean context",
        );
        expect(h.packets.at(-1)).toBe("Goal: ship it");
        // A fresh start never joins a running turn.
        expect(h.sends.map((send) => [send.mode, send.freshContext])).toEqual([
          ["auto", false],
          ["auto", false],
          ["queue", true],
        ]);
      }),
    ),
  );

  it.effect("renames the bot and moves it and its threads to the models the user picks", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Ops", modelSelection: MODEL });
        const store = h.runtime.existingStore()!;
        h.projects.push({ id: "p1", title: "Repo", workspaceRoot: "/repo" });
        yield* h.bot.sendMessage({ botId, text: "Hi" });
        yield* endRun(h, botId, 0, "Hello.");
        const workThreadId = (yield* store.getBot(botId))!.workThreadId!;
        const limits = { turnsPerDay: 100, maxThreads: 3 };
        const codex = {
          instanceId: "codex",
          model: "gpt-5.5",
          options: [{ id: "effort", value: "high" }],
        };

        yield* h.bot.saveSettings({ botId, name: " DevOps ", settings: limits });
        expect((yield* store.getBot(botId))?.name).toBe("DevOps");
        expect(h.titles).toEqual([{ threadId: workThreadId, title: "DevOps (bot)" }]);
        expect((yield* store.queued(botId)).map((event) => event.text)).toEqual([
          "The user renamed you from Ops to DevOps.",
        ]);
        expect(
          (yield* httpFailure(h.bot.saveSettings({ botId, name: " ", settings: limits }))).detail,
        ).toContain("Name the bot");

        // Its threads run on the model set for them, effort included, unless it names another.
        yield* h.bot.saveSettings({ botId, settings: { ...limits, threadModel: codex } });
        const start = (...flags: string[]) =>
          h.bot.runTool({
            bot: botId,
            argv: ["thread", "start", "--project=Repo", ...flags, "Go"],
            stdin: "",
          });
        yield* start();
        expect(h.models.at(-1)).toEqual(codex);
        yield* start("--provider", MODEL.instanceId, "--model", MODEL.model);
        expect(h.models.at(-1)).toEqual({ instanceId: MODEL.instanceId, model: MODEL.model });
        expect(yield* h.bot.runTool({ bot: botId, argv: ["help"], stdin: "" })).toContain(
          "runs on --provider codex --model gpt-5.5",
        );
        yield* h.bot.saveSettings({ botId, settings: { ...limits, threadModel: null } });
        yield* start();
        expect(h.models.at(-1)).toEqual(MODEL);

        // Its own turns move to another provider on a fresh session, not a handed-over one.
        yield* h.bot.saveSettings({ botId, modelSelection: codex, settings: limits });
        expect((yield* store.getBot(botId))?.modelSelection).toEqual(codex);
        yield* h.bot.sendMessage({ botId, text: "Still there?" });
        expect(h.sends.at(-1)).toEqual({ mode: "queue", freshContext: true });
      }),
    ),
  );

  it.effect("accepts a tool call only with the token of a bot that exists", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const token = yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(h.runtime.botsDir, botId, "token"), "utf8"),
        );
        const call = (bot: string, given: string) =>
          h.bot.authenticateTool(`Bearer ${given}`, { bot, argv: ["help"], stdin: "" });
        expect((yield* call(botId, token)).bot).toBe(botId);
        expect((yield* httpFailure(call(botId, "wrong"))).status).toBe(401);
        // A token file outside any stored bot is never read.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(h.runtime.botsDir, "token"), "planted"),
        );
        expect((yield* httpFailure(call(".", "planted"))).status).toBe(401);
      }),
    ),
  );

  it.effect("shows only notes inside the bot's folder, not where a link points", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const notes = NodePath.join(h.runtime.botsDir, botId, "workspace", "notes");
        const outside = NodePath.join(h.runtime.botsDir, "secret.txt");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(notes, "plan.md"), "Plan");
          await NodeFSP.writeFile(outside, "secret");
          await NodeFSP.symlink(outside, NodePath.join(notes, "link.md"));
        });
        const read = (name: string) => h.bot.readNote(new URLSearchParams({ botId, name }));
        expect((yield* read("plan.md")).text).toBe("Plan");
        expect((yield* httpFailure(read("link.md"))).status).toBe(404);
      }),
    ),
  );

  it.effect(
    "reports what its thread did while the server was down once, and leaves a thread the user took over until handed back",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
          const store = h.runtime.existingStore()!;
          for (const threadId of ["t-down", "t-taken"]) {
            yield* store.addThread({
              threadId,
              botId,
              projectId: "p",
              itemId: null,
              follow: "attention",
              createdAt: "t0",
            });
            h.runtime.ownedThreads.set(threadId, botId);
          }
          h.shells.set("t-down", { latestRunId: "r1", status: "failed" });
          yield* reconcileThreads();
          yield* reconcileThreads();
          expect(h.runs).toHaveLength(1);
          expect(h.packets[0]).toContain("Thread t-down failed");

          // The user types in a bot's thread: it is theirs, and its end wakes nobody.
          h.userMessages.set("t-taken", [{ createdBy: "user", createdAt: DateTime.makeUnsafe(0) }]);
          const run = (status: string) =>
            ({ type: "run.updated", threadId: "t-taken", payload: { id: "r2", status } }) as never;
          yield* followThreads(Stream.make(run("running"), run("failed")));
          expect((yield* store.getThread("t-taken"))?.takenOver).toBe(true);
          expect((yield* store.queued(botId)).map((event) => event.text)).toEqual([
            expect.stringContaining("The user took over thread t-taken"),
          ]);
          const refused = yield* httpFailure(
            h.bot.runTool({
              bot: botId,
              argv: ["thread", "send", "t-taken", "Carry on"],
              stdin: "",
            }),
          );
          expect(refused.detail).toContain("took this thread over");

          yield* h.bot.handBack({ botId, threadId: "t-taken" });
          expect((yield* store.getThread("t-taken"))?.takenOver).toBe(false);
          expect((yield* store.queued(botId)).at(-1)).toMatchObject({ wakes: true });
          expect((yield* store.queued(botId)).at(-1)?.text).toContain("handed thread t-taken back");
        }),
      ),
  );

  it.effect(
    "takes a thread as the user's from a run seen only as ended, and never from T3's own messages",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
          const store = h.runtime.existingStore()!;
          for (const [threadId, message] of [
            // The user typed here while the server was down; only the end of their run is seen.
            ["t-user-down", { createdBy: "user" }],
            // Messages T3 writes with the user role are not the user's.
            ["t-notified", { createdBy: "user", notification: {} }],
            ["t-delegated", { createdBy: "user", delegatedCompletion: {} }],
            ["t-compacted", { createdBy: "user", idleCompaction: {} }],
          ] as const) {
            yield* store.addThread({
              threadId,
              botId,
              projectId: "p",
              itemId: null,
              follow: "routine",
              createdAt: "t0",
            });
            h.runtime.ownedThreads.set(threadId, botId);
            h.userMessages.set(threadId, [{ ...message, createdAt: DateTime.makeUnsafe(0) }]);
            h.shells.set(threadId, { latestRunId: `${threadId}-run`, status: "completed" });
          }
          yield* reconcileThreads();
          const queued = (yield* store.queued(botId)).map((event) => event.text);
          expect(queued).toContainEqual(
            expect.stringContaining("The user took over thread t-user-down"),
          );
          expect(queued).not.toContainEqual(expect.stringContaining("t-user-down completed"));
          expect((yield* store.getThread("t-user-down"))?.takenOver).toBe(true);
          for (const threadId of ["t-notified", "t-delegated", "t-compacted"]) {
            expect((yield* store.getThread(threadId))?.takenOver).toBe(false);
            expect(queued).toContainEqual(expect.stringContaining(`Thread ${threadId} completed`));
          }
        }),
      ),
  );

  it.effect("lists the skills a bot wrote and the shared ones, its own winning a name", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const write = (dir: string, body: string) =>
          Effect.promise(async () => {
            await NodeFSP.mkdir(dir, { recursive: true });
            await NodeFSP.writeFile(NodePath.join(dir, "SKILL.md"), body);
          });
        const own = NodePath.join(h.runtime.botsDir, botId, "workspace", "skills");
        const shared = NodePath.join(h.runtime.botsDir, "skills");
        yield* write(
          NodePath.join(own, "ci"),
          '---\nname: ci-check\ndescription: "Use when CI on r/* is red."\n---\nSteps',
        );
        yield* write(
          NodePath.join(shared, "ci-copy"),
          "---\nname: ci-check\ndescription: older shared copy\n---\n",
        );
        yield* write(NodePath.join(shared, "release"), "No frontmatter here.");
        yield* h.bot.sendMessage({ botId, text: "Hi" });
        const skills = h.packets[0]!.split("Skills:\n")[1]!.split("\n").slice(0, 3);
        expect(skills).toEqual([
          `  ci-check: Use when CI on r/* is red. - ${NodePath.join(own, "ci", "SKILL.md")}`,
          `  release (shared): (no description) - ${NodePath.join(shared, "release", "SKILL.md")}`,
          expect.not.stringContaining("older shared copy"),
        ]);
      }),
    ),
  );
});

describe("t3bot arguments", () => {
  it.each([
    {
      argv: ["say", "Please", "run", "--dry-run", "first"],
      positional: ["say", "Please", "run", "--dry-run", "first"],
      flags: {},
    },
    {
      argv: ["thread", "start", "--project=t3code", "--follow=now", "--worktree", "Go"],
      positional: ["thread", "start", "Go"],
      flags: { project: "t3code", follow: "now", worktree: "true" },
    },
    {
      argv: ["thread", "start", "--project", "t3code", "--", "--title", "is", "text"],
      positional: ["thread", "start", "--title", "is", "text"],
      flags: { project: "t3code" },
    },
    {
      argv: ["thread", "send", "t1", "use", "--worktree", "--title", "x"],
      positional: ["thread", "send", "t1", "use", "--worktree", "--title", "x"],
      flags: {},
    },
    {
      argv: ["item", "add", "--note=a=b", "--unknown", "Title"],
      positional: ["item", "add", "--unknown", "Title"],
      flags: { note: "a=b" },
    },
  ])("parses $argv", ({ argv, positional, flags }) => {
    const parsed = parseArgs(argv);
    expect(parsed.positional).toEqual(positional);
    expect(Object.fromEntries(parsed.flags)).toEqual(flags);
  });

  it("parses a connector's flags from its own spec", () => {
    const parsed = parseArgs(
      ["lark", "send", "oc_1", "--reply-to", "om_2", "Done,", "--see-above"],
      {
        values: ["reply-to"],
      },
    );
    expect(parsed.positional).toEqual(["lark", "send", "oc_1", "Done,", "--see-above"]);
    expect(Object.fromEntries(parsed.flags)).toEqual({ "reply-to": "om_2" });
  });

  it.each([
    { reply: "NO_REPLY", posted: null },
    { reply: "Done.\n\nNO_REPLY", posted: "Done." },
    { reply: "Done.\nNO_REPLY if you'd like me to hold here.", posted: "Done." },
    { reply: "Say NO_REPLY when quiet.", posted: "Say NO_REPLY when quiet." },
  ])("posts $reply as $posted", ({ reply, posted }) => {
    expect(Bots.replyText(reply)).toBe(posted);
  });

  it("quotes the tool's path for the shell", () => {
    expect(Bots.shellQuote("/home/me/.t3/bots/bin/t3bot")).toBe("/home/me/.t3/bots/bin/t3bot");
    expect(Bots.shellQuote("/Users/me/Library/Application Support/t3")).toBe(
      "'/Users/me/Library/Application Support/t3'",
    );
    expect(Bots.shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("activityLine", () => {
  it("carries a tool step's item for clients to label, without its output", () => {
    const at = DateTime.makeUnsafe("2026-11-27T00:00:00.000Z");
    const line = Bots.activityLine({
      type: "command_execution",
      id: "item-1",
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "running",
      title: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
      input: "rg -n token src",
      output: "src/a.ts:1: token",
    } as never);
    expect(line).toMatchObject({ key: "step:item-1", text: "rg -n token src" });
    expect(line?.step).toMatchObject({ type: "command_execution", input: "rg -n token src" });
    expect(line?.step).not.toHaveProperty("output");
    expect(
      Bots.activityLine({ type: "command_execution", id: "item-1" } as never, "step:item-1"),
    ).toBeNull();
  });
});

describe("bot role", () => {
  it.effect("adds one rule the user approves, and shows only what an edit changes", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const store = h.runtime.existingStore()!;
        const roleOf = () =>
          NodeFSP.readFile(NodePath.join(h.runtime.botsDir, botId, "role.md"), "utf8");
        const approveLast = Effect.fn("Test.approveLast")(function* () {
          const question = (yield* store.openQuestions(botId)).at(-1)!;
          return yield* h.bot
            .answerQuestion({ botId, questionId: question.id, approve: true })
            .pipe(Effect.as(question.text));
        });

        yield* h.bot.saveRole({ botId, role: "Watch CI.\n\n## Rules\n- Ask before main." });
        yield* h.bot.runTool({
          bot: botId,
          argv: ["role", "add", "Never run bare t3 update."],
          stdin: "",
        });
        expect(yield* approveLast()).toBe("add to its role\n\nNever run bare t3 update.");
        expect(yield* Effect.promise(roleOf)).toBe(
          "Watch CI.\n\n## Rules\n- Ask before main.\n- Never run bare t3 update.",
        );

        yield* h.bot.runTool({
          bot: botId,
          argv: ["role", "edit", "-"],
          stdin:
            "Watch CI and releases.\n\n## Rules\n- Ask before main.\n- Never run bare t3 update.",
        });
        expect(yield* approveLast()).toBe(
          "change its role\n\nAdds:\nWatch CI and releases.\n\nRemoves:\nWatch CI.",
        );
        expect(
          yield* h.bot.runTool({
            bot: botId,
            argv: ["role", "edit", "-"],
            stdin: yield* Effect.promise(roleOf),
          }),
        ).toBe("Role unchanged.");
      }),
    ),
  );
});

describe("bot memory", () => {
  it.effect("forgets a note the user removes, and only that bot's", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({
          name: "Release Watcher",
          modelSelection: MODEL,
        });
        const store = h.runtime.existingStore()!;
        const kept = yield* store.addMemory(botId, "Releases ship from r/main.");
        const dropped = yield* store.addMemory(botId, "Old host is gone.");

        yield* h.bot.forgetMemory({ botId, memoryId: dropped });
        expect(yield* store.listMemory(botId)).toEqual([
          { id: kept, text: "Releases ship from r/main." },
        ]);

        const missing = yield* httpFailure(h.bot.forgetMemory({ botId, memoryId: dropped }));
        expect(missing.status).toBe(404);
      }),
    ),
  );

  it.effect("moves a rule filed as memory into the role", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* h.bot.createBot({ name: "Bot", modelSelection: MODEL });
        const store = h.runtime.existingStore()!;
        yield* h.bot.saveRole({ botId, role: "Watch CI." });
        const rule = yield* store.addMemory(botId, "Never run bare t3 update.");

        yield* h.bot.moveMemoryToRole({ botId, memoryId: rule });
        expect(yield* store.listMemory(botId)).toEqual([]);
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(h.runtime.botsDir, botId, "role.md"), "utf8"),
          ),
        ).toBe("Watch CI.\n- Never run bare t3 update.");
      }),
    ),
  );
});
