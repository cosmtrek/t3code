// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off - Bots keep their role in a temporary folder; routines run on local wall-clock dates.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProjectId, type OrchestrationV2RunStatus } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../project/ProjectService.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { BotRuntime, type BotRuntimeShape } from "./BotRuntime.ts";
import { followThreads, reconcileThreads } from "./events.ts";
import * as Bots from "./operations.ts";
import { answerQuestion, MEMORY_BYTES, runTool } from "./tools.ts";
import { BotStore } from "./store.ts";

const MODEL = { instanceId: "claudeAgent", model: "claude-haiku-5-5" };
const SCRATCH = ProjectId.make("scratch");

interface Harness {
  readonly runtime: BotRuntimeShape;
  /** Every packet the bot was sent, launch or send, in order. */
  readonly packets: string[];
  /** Thread id and run id of each turn, in order. */
  readonly runs: Array<{ readonly threadId: string; readonly runId: string }>;
  /** Runs and their assistant replies, as T3 would answer for them. */
  readonly runStatus: Map<string, OrchestrationV2RunStatus>;
  readonly replies: Map<string, string>;
  /** Thread shells, as reconcile reads them after a restart. */
  readonly shells: Map<string, { latestRunId: string; status: string }>;
  /** Messages typed with the user role in a thread, for the takeover check. */
  readonly userMessages: Map<string, Array<{ createdBy: string; createdAt: DateTime.Utc }>>;
  readonly layer: Layer.Layer<HarnessServices>;
}

type HarnessServices =
  | BotRuntime
  | ThreadManagement.ThreadManagementService
  | ThreadLaunch.ThreadLaunchService
  | ManagedProjectFolders
  | ProviderRegistry.ProviderRegistry
  | ServerConfig.ServerConfig
  | DocumentText.DocumentText
  | FileSystem.FileSystem
  | Project.ProjectService;

async function harness(store = new BotStore(":memory:")): Promise<Harness> {
  const botsDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bots-"));
  const runtime: BotRuntimeShape = {
    botsDir,
    cliPath: "/bin/t3bot",
    ensureCli: Effect.void,
    ownedThreads: new Map(),
    existingStore: () => store,
    store: () => store,
    active: Latch.makeUnsafe(false),
    turnLock: Semaphore.makeUnsafe(1),
    workThreads: new Map(
      store
        .listBots()
        .flatMap((bot) => (bot.workThreadId === null ? [] : [[bot.workThreadId, bot.id] as const])),
    ),
    publish: () => undefined,
    subscribe: () => () => undefined,
  };
  const packets: string[] = [];
  const runs: Array<{ threadId: string; runId: string }> = [];
  const runStatus = new Map<string, OrchestrationV2RunStatus>();
  const replies = new Map<string, string>();
  const shells = new Map<string, { latestRunId: string; status: string }>();
  const userMessages = new Map<string, Array<{ createdBy: string; createdAt: DateTime.Utc }>>();
  const nextRun = (threadId: string) => {
    const runId = `run-${runs.length + 1}`;
    runs.push({ threadId, runId });
    runStatus.set(runId, "running");
    return runId;
  };
  const layer = Layer.mergeAll(
    Layer.succeed(BotRuntime, runtime),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadTitles: () => Effect.succeed({}),
      sendToThread: (input) => {
        // No turn is ever mid-provider-turn here, so a steer lands in the queue as T3 would.
        if (input.mode === "steer") {
          return Effect.succeed({ delivery: "queued", run: { id: "steer" } } as never);
        }
        packets.push(input.text);
        return Effect.succeed({ run: { id: nextRun(input.threadId) } } as never);
      },
      getThreadShell: (threadId) => {
        const shell = shells.get(threadId);
        return shell === undefined
          ? Effect.fail("missing" as never)
          : Effect.succeed({ ...shell, pendingRuntimeRequest: null } as never);
      },
      getProjectThreadRecords: (input, _fields, filter) =>
        Effect.succeed({
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
        } as never),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        packets.push(input.initialMessage?.text ?? "");
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
    Layer.mock(Project.ProjectService)({ listShells: () => Effect.succeed([]) }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.succeed(ServerConfig.ServerConfig, {} as never),
    FileSystem.layerNoop({}),
  );
  return { runtime, packets, runs, runStatus, replies, shells, userMessages, layer };
}

const chatOf = (h: Harness, botId: string) =>
  h.runtime
    .store()
    .recentChat(botId, 100)
    .map((message) => [message.role, message.text]);

/** T3 ends the run with this reply, as the domain event follower would report it. */
const endRun = (h: Harness, botId: string, index: number, reply: string | null) => {
  const { runId } = h.runs[index]!;
  h.runStatus.set(runId, "completed");
  if (reply !== null) h.replies.set(runId, reply);
  return Bots.finishRun(botId, runId, "completed");
};

const withHarness = <E>(
  program: (h: Harness) => Effect.Effect<void, E, HarnessServices>,
  store?: BotStore,
) =>
  Effect.promise(() => harness(store)).pipe(
    Effect.flatMap((h) =>
      program(h).pipe(
        Effect.provide(h.layer),
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(h.runtime.botsDir, { recursive: true, force: true })),
        ),
      ),
    ),
  );

describe("bot turns", () => {
  it.effect("answers each message in one turn at a time, in its one work thread", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Release Watcher", modelSelection: MODEL });
        yield* Bots.saveRole({ botId, role: "Keep fork releases healthy." });

        yield* Bots.sendMessage({ botId, text: "What do you do?" });
        // A second message while the turn runs waits for it.
        yield* Bots.sendMessage({ botId, text: "And how often?" });
        expect(h.runs).toHaveLength(1);
        expect(h.packets[0]).toContain("Keep fork releases healthy.");
        expect(h.packets[0]).toContain("What do you do?");

        yield* endRun(h, botId, 0, "I watch the fork's releases.");
        expect(h.runs).toHaveLength(2);
        expect(h.runs[1]!.threadId).toBe(h.runs[0]!.threadId);
        // The next turn carries the answered exchange as context and only the waiting message as new.
        const [context, fresh] = h.packets[1]!.split("New from the user");
        expect(context).toContain("I watch the fork's releases.");
        expect(fresh).toContain("And how often?");
        expect(fresh).not.toContain("What do you do?");

        yield* endRun(h, botId, 1, null);
        expect(chatOf(h, botId)).toEqual([
          ["user", "What do you do?"],
          ["user", "And how often?"],
          ["bot", "I watch the fork's releases."],
          ["error", "The turn ended without a reply."],
        ]);
        expect(h.runtime.store().getTurn(botId)).toBeNull();
      }),
    ),
  );

  it.effect("finishes a turn whose run ended while the server was down, once", () => {
    const store = new BotStore(":memory:");
    store.createBot({ id: "bot_1", name: "Bot", modelSelection: MODEL as never, createdAt: "t0" });
    store.setWorkThread("bot_1", "thread-1", SCRATCH);
    store.addChat({ id: "m1", botId: "bot_1", role: "user", text: "Hi", createdAt: "t1" });
    store.startTurn(
      { botId: "bot_1", runId: "run-down", threadId: "thread-1", startedAt: "t1" },
      ["m1"],
      [],
    );
    return withHarness(
      (h) =>
        Effect.gen(function* () {
          h.runStatus.set("run-down", "completed");
          h.replies.set("run-down", "Hello.");
          yield* Bots.reconcile();
          // The event for the same run, arriving late, posts nothing more.
          yield* Bots.finishRun("bot_1", "run-down", "completed");
          expect(chatOf(h, "bot_1")).toEqual([
            ["user", "Hi"],
            ["bot", "Hello."],
          ]);
          expect(h.runs).toHaveLength(0);
        }),
      store,
    );
  });

  it.effect(
    "fires a routine missed while down once, saying it is late, then sets the next time",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
          const store = h.runtime.store();
          const id = store.addRoutine(botId, {
            title: "PR check",
            prompt: "Check open PRs.",
            schedule: { type: "daily", time: "09:00" },
            // Missed on three mornings while the server was down.
            nextDueAt: new Date(2026, 10, 20, 9, 0).toISOString(),
          });
          yield* Bots.fireDueRoutines(new Date(2026, 10, 23, 11, 40));
          expect(h.runs).toHaveLength(1);
          expect(h.packets[0]).toContain(
            'Routine 1 "PR check" is due. It was due at 09:00 and starts late, at 11:40.',
          );
          expect(store.listRoutines(botId).find((routine) => routine.id === id)?.nextDueAt).toBe(
            new Date(2026, 10, 24, 9, 0).toISOString(),
          );
          // A turn with nothing worth telling ends with NO_REPLY and posts nothing.
          yield* endRun(h, botId, 0, Bots.NO_REPLY);
          expect(chatOf(h, botId)).toEqual([]);
        }),
      ),
  );

  it.effect("queues a thread's end for the bot and wakes it only as its follow-up says", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
        const store = h.runtime.store();
        for (const [threadId, follow] of [
          ["t-attention", "attention"],
          ["t-now", "now"],
        ] as const) {
          store.addThread({
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
        expect(store.queued(botId).map((event) => event.wakes)).toEqual([false]);
        // A finished now thread wakes the bot, and that turn takes both events.
        yield* followThreads(Stream.make(ended("t-now", "completed")));
        expect(h.runs).toHaveLength(1);
        expect(h.packets[0]).toContain("Thread t-attention completed");
        expect(h.packets[0]).toContain("Thread t-now completed");
        expect(store.queued(botId)).toEqual([]);
      }),
    ),
  );

  it.effect("posts what the bot says instead of its last message, and caps memory", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
        yield* Bots.sendMessage({ botId, text: "Remember my timezone." });
        yield* runTool({ bot: botId, argv: ["memory", "add", "The user is in UTC+8."], stdin: "" });
        const full = yield* Effect.flip(
          runTool({ bot: botId, argv: ["memory", "add", "x".repeat(MEMORY_BYTES)], stdin: "" }),
        );
        expect(full.detail).toContain("Merge or remove notes first");
        yield* runTool({ bot: botId, argv: ["say", "Noted: UTC+8."], stdin: "" });
        yield* endRun(h, botId, 0, "I saved it with memory add and replied.");
        expect(chatOf(h, botId)).toEqual([
          ["user", "Remember my timezone."],
          ["bot", "Noted: UTC+8."],
        ]);
        expect(
          h.runtime
            .store()
            .listMemory(botId)
            .map((note) => note.text),
        ).toEqual(["The user is in UTC+8."]);
      }),
    ),
  );

  it.effect(
    "asks before a gated action, runs exactly that call once approved, and lets it lapse",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
          const store = h.runtime.store();
          const roleOf = () => NodeFSP.readFile(Bots.rolePath(h.runtime.botsDir, botId), "utf8");
          const edit = (role: string) =>
            runTool({ bot: botId, argv: ["role", "edit", "-"], stdin: role });

          // Editing its role asks by default: nothing changes until the user approves.
          expect(yield* edit("Watch CI.")).toContain("the user must approve");
          const [question] = store.openQuestions(botId);
          expect(question?.text).toContain("Watch CI.");
          expect(yield* Effect.promise(() => roleOf().catch(() => ""))).toBe("");
          yield* answerQuestion({ botId, questionId: question!.id, approve: true });
          expect(yield* Effect.promise(roleOf)).toBe("Watch CI.");
          // The answer wakes the bot.
          expect(h.packets.at(-1)).toContain(
            "approved your question 1, and it ran: Role replaced.",
          );
          // A question is answered once.
          const again = yield* Effect.flip(
            answerQuestion({ botId, questionId: question!.id, approve: true }),
          );
          expect(again.code).toBe("question_closed");

          // Unanswered, it lapses after a day and its action never runs.
          yield* edit("Watch nothing.");
          // Well past its 24 hours.
          yield* Bots.fireDueRoutines(new Date(2100, 0, 1));
          expect(store.openQuestions(botId)).toEqual([]);
          expect(store.queued(botId).at(-1)?.text).toContain("lapsed unanswered");
          expect(yield* Effect.promise(roleOf)).toBe("Watch CI.");

          // Denied, it is refused outright.
          yield* Bots.saveSettings({
            botId,
            settings: { permissions: { "role.edit": "deny" }, turnsPerDay: 100, maxThreads: 3 },
          });
          const denied = yield* Effect.flip(edit("Anything."));
          expect(denied.detail).toContain("does not let you replace its role");
        }),
      ),
  );

  it.effect("holds turns while paused and past the day's budget, saying so once", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
        yield* Bots.setPaused({ botId, paused: true });
        yield* Bots.sendMessage({ botId, text: "Hi" });
        expect(h.runs).toHaveLength(0);
        yield* Bots.setPaused({ botId, paused: false });
        expect(h.runs).toHaveLength(1);

        yield* Bots.saveSettings({
          botId,
          settings: { permissions: {}, turnsPerDay: 1, maxThreads: 3 },
        });
        yield* endRun(h, botId, 0, "Hello.");
        yield* Bots.sendMessage({ botId, text: "Still there?" });
        yield* Bots.sendMessage({ botId, text: "Hello?" });
        expect(h.runs).toHaveLength(1);
        expect(chatOf(h, botId).filter(([role]) => role === "error")).toEqual([
          [
            "error",
            "Bot used its 1 turns for today. What happens meanwhile waits for tomorrow, or raise its budget.",
          ],
        ]);
      }),
    ),
  );

  it.effect(
    "reports what its thread did while the server was down once, and leaves a thread the user took over until handed back",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
          const store = h.runtime.store();
          for (const threadId of ["t-down", "t-taken"]) {
            store.addThread({
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
          expect(store.getThread("t-taken")?.takenOver).toBe(true);
          expect(store.queued(botId).map((event) => event.text)).toEqual([
            expect.stringContaining("The user took over thread t-taken"),
          ]);
          const refused = yield* Effect.flip(
            runTool({ bot: botId, argv: ["thread", "send", "t-taken", "Carry on"], stdin: "" }),
          );
          expect(refused.detail).toContain("took this thread over");

          yield* Bots.handBack({ botId, threadId: "t-taken" });
          expect(store.getThread("t-taken")?.takenOver).toBe(false);
          expect(store.queued(botId).at(-1)).toMatchObject({ wakes: true });
          expect(store.queued(botId).at(-1)?.text).toContain("handed thread t-taken back");
        }),
      ),
  );
});
