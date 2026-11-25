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
import { answerQuestion, authenticateTool, MEMORY_BYTES, parseArgs, runTool } from "./tools.ts";
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
  readonly userMessages: Map<string, Array<UserMessage>>;
  /** The runtime mode of each launch, and each later switch of one, in order. */
  readonly modes: string[];
  /** The model selection of each launch, in order. */
  readonly models: unknown[];
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
    threadStartLock: Semaphore.makeUnsafe(1),
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
  const userMessages = new Map<string, Array<UserMessage>>();
  const projects: Harness["projects"] = [];
  const ownedAtLaunch: boolean[] = [];
  const modes: string[] = [];
  const models: unknown[] = [];
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
      dispatch: (command) => {
        if (command.type === "thread.runtime-mode.set") modes.push(command.runtimeMode);
        return Effect.succeed({} as never);
      },
      sendToThread: (input) => {
        // No turn is ever mid-provider-turn here, so a steer lands in the queue as T3 would.
        if (input.mode === "steer") {
          return Effect.succeed({ delivery: h.steerDelivery, run: { id: "steer" } } as never);
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
        if (input.projectId !== SCRATCH) {
          ownedAtLaunch.push(runtime.ownedThreads.has(input.threadId!));
          if (input.initialMessage?.text === "fail") return Effect.fail({ message: "no" } as never);
        }
        packets.push(input.initialMessage?.text ?? "");
        modes.push(input.runtimeMode);
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
      ] as never),
    }),
    Layer.succeed(ServerConfig.ServerConfig, {} as never),
    FileSystem.layerNoop({}),
  );
  const h: Harness = {
    runtime,
    packets,
    runs,
    runStatus,
    replies,
    shells,
    userMessages,
    steerDelivery: "queued",
    projects,
    ownedAtLaunch,
    modes,
    models,
    layer,
  };
  return h;
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
        // The session holds the first turn, so the next carries only the waiting message.
        expect(h.packets[1]).toContain("And how often?");
        expect(h.packets[1]).not.toContain("What do you do?");
        expect(h.packets[1]).not.toContain("Keep fork releases healthy.");

        yield* endRun(h, botId, 1, null);
        expect(chatOf(h, botId)).toEqual([
          ["user", "What do you do?"],
          ["user", "And how often?"],
          ["bot", "I watch the fork's releases."],
          ["error", "The turn ended without a reply."],
        ]);
        expect(h.runtime.store().getTurn(botId)).toBeNull();
        // Its posts count as unread on the Bots entry until the user sees its chat.
        const unread = () => Bots.listBots().pipe(Effect.map(({ bots }) => bots[0]!.unread));
        expect(yield* unread()).toBe(2);
        yield* Bots.markSeen({ botId });
        expect(yield* unread()).toBe(0);

        // A failed turn may have lost what it was sent, so the one after resends it all.
        yield* Bots.sendMessage({ botId, text: "Still there?" });
        yield* Bots.finishRun(botId, h.runs[2]!.runId, "failed");
        yield* Bots.sendMessage({ botId, text: "Hello?" });
        expect(h.packets[3]).toContain("Keep fork releases healthy.");
      }),
    ),
  );

  it.effect("finishes a turn whose run ended while the server was down, once", () => {
    const store = new BotStore(":memory:");
    store.createBot(
      { id: "bot_1", name: "Bot", modelSelection: MODEL as never, createdAt: "t0" },
      "auto",
    );
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
          settings: { turnsPerDay: 1, maxThreads: 3 },
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
        const read = () => Bots.readBot(new URLSearchParams({ botId }));
        expect((yield* read()).bot.turnsToday).toBe(1);

        // One more turn a day lets the held messages run now.
        yield* Bots.saveSettings({
          botId,
          settings: { turnsPerDay: 2, maxThreads: 3 },
        });
        expect(h.runs).toHaveLength(2);
        expect((yield* read()).bot.turnsToday).toBe(2);

        // A count left from an earlier day reads as none used today.
        h.runtime.store().countTurn(botId, "2000-01-01");
        expect((yield* read()).bot.turnsToday).toBe(0);
      }),
    ),
  );

  it.effect("runs its work thread in the mode the user picks, and switches it on a change", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        // No pick: the broadest the provider offers up to auto, which it lacks.
        const unpicked = yield* Bots.createBot({ name: "Default", modelSelection: MODEL });
        expect(h.runtime.store().getBot(unpicked.botId)?.settings.runtimeMode).toBe(
          "auto-accept-edits",
        );
        const { botId } = yield* Bots.createBot({
          name: "Ops",
          modelSelection: MODEL,
          runtimeMode: "full-access",
        });
        yield* Bots.sendMessage({ botId, text: "Hi" });
        yield* Bots.saveSettings({
          botId,
          settings: { turnsPerDay: 100, maxThreads: 3, runtimeMode: "auto" },
        });
        expect(h.modes).toEqual(["full-access", "auto-accept-edits"]);
        expect(h.runtime.store().getBot(botId)?.settings.runtimeMode).toBe("auto");
      }),
    ),
  );

  it.effect("gives one bot per channel the user's mentions, and none while its chat is off", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const store = h.runtime.store();
        const first = yield* Bots.createBot({ name: "Inbox", modelSelection: MODEL });
        const second = yield* Bots.createBot({ name: "Other", modelSelection: MODEL });
        const save = (botId: string, channelsEnabled: boolean, mentions: boolean) =>
          Bots.saveSettings({
            botId,
            settings: {
              turnsPerDay: 100,
              maxThreads: 3,
              channelsEnabled,
              channels: { lark: { send: "ask", mentions } },
            },
          });
        const lark = (botId: string) => store.getBot(botId)!.settings.channels.lark;
        expect(store.getBot(first.botId)!.settings.channelsEnabled).toBe(false);

        yield* save(first.botId, true, true);
        const since = lark(first.botId)?.mentionsSince;
        expect(since).toEqual(expect.any(String));
        // Saving again keeps when it took mentions on.
        yield* save(first.botId, true, true);
        expect(lark(first.botId)?.mentionsSince).toBe(since);

        yield* save(second.botId, true, true);
        expect(lark(first.botId)?.mentions).toBe(false);
        expect(lark(second.botId)?.mentions).toBe(true);

        yield* save(second.botId, false, true);
        expect(lark(second.botId)?.mentions).toBe(false);

        // A setting from before the threads switch: a denied action now asks, never allows.
        store.setSettings(first.botId, {
          permissions: { "thread.start": "deny", "thread.send": "allow" },
        } as never);
        expect(store.getBot(first.botId)!.settings.threads).toBe("ask");
      }),
    ),
  );

  it.effect("offers no chat where the environment has no chat channel", () =>
    withHarness(() =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
        expect(yield* runTool({ bot: botId, argv: ["help"], stdin: "" })).not.toContain(
          "chat read",
        );
        const refused = yield* Effect.flip(
          runTool({ bot: botId, argv: ["chat", "unread"], stdin: "" }),
        );
        expect(refused.detail).toBe("No chat channel is set up here.");
      }),
    ),
  );

  it.effect("joins a message to the running turn when T3 steers it in", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
        yield* Bots.sendMessage({ botId, text: "Start." });
        h.steerDelivery = "steered";
        const { messageId } = yield* Bots.sendMessage({ botId, text: "Also this." });
        const steered = h.runtime
          .store()
          .recentChat(botId, 10)
          .find((message) => message.id === messageId);
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
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: ownModel });
        h.projects.push({ id: "p1", title: "Repo", workspaceRoot: "/repo" });
        const start = (prompt: string) =>
          runTool({
            bot: botId,
            argv: ["thread", "start", "--project=Repo", "--follow", "now", prompt],
            stdin: "",
          });
        expect(yield* start("Fix --flaky tests")).toContain("started in Repo");
        expect(h.ownedAtLaunch).toEqual([true]);
        const [owned] = h.runtime.store().listThreads(botId);
        expect(owned?.follow).toBe("now");
        expect(h.packets.at(-1)).toBe("Fix --flaky tests");
        // Its own model, so its own effort rather than the provider's default.
        expect(h.models.at(-1)).toEqual(ownModel);

        const failed = yield* Effect.flip(start("fail"));
        expect(failed.detail).toContain("did not start");
        expect(h.runtime.store().listThreads(botId)).toHaveLength(1);
        expect(h.runtime.ownedThreads.size).toBe(1);
      }),
    ),
  );

  it.effect("accepts a tool call only with the token of a bot that exists", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
        const token = yield* Effect.promise(() =>
          NodeFSP.readFile(Bots.tokenPath(h.runtime.botsDir, botId), "utf8"),
        );
        const call = (bot: string, given: string) =>
          authenticateTool(`Bearer ${given}`, { bot, argv: ["help"], stdin: "" });
        expect((yield* call(botId, token)).bot).toBe(botId);
        expect((yield* Effect.flip(call(botId, "wrong"))).status).toBe(401);
        // A token file outside any stored bot is never read.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(h.runtime.botsDir, "token"), "planted"),
        );
        expect((yield* Effect.flip(call(".", "planted"))).status).toBe(401);
      }),
    ),
  );

  it.effect("shows only notes inside the bot's folder, not where a link points", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
        const notes = NodePath.join(h.runtime.botsDir, botId, "workspace", "notes");
        const outside = NodePath.join(h.runtime.botsDir, "secret.txt");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(notes, "plan.md"), "Plan");
          await NodeFSP.writeFile(outside, "secret");
          await NodeFSP.symlink(outside, NodePath.join(notes, "link.md"));
        });
        const read = (name: string) => Bots.readNote(new URLSearchParams({ botId, name }));
        expect((yield* read("plan.md")).text).toBe("Plan");
        expect((yield* Effect.flip(read("link.md"))).status).toBe(404);
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

  it.effect(
    "takes a thread as the user's from a run seen only as ended, and never from T3's own messages",
    () =>
      withHarness((h) =>
        Effect.gen(function* () {
          const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
          const store = h.runtime.store();
          for (const [threadId, message] of [
            // The user typed here while the server was down; only the end of their run is seen.
            ["t-user-down", { createdBy: "user" }],
            // Messages T3 writes with the user role are not the user's.
            ["t-notified", { createdBy: "user", notification: {} }],
            ["t-delegated", { createdBy: "user", delegatedCompletion: {} }],
            ["t-compacted", { createdBy: "user", idleCompaction: {} }],
          ] as const) {
            store.addThread({
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
          const queued = store.queued(botId).map((event) => event.text);
          expect(queued).toContainEqual(
            expect.stringContaining("The user took over thread t-user-down"),
          );
          expect(queued).not.toContainEqual(expect.stringContaining("t-user-down completed"));
          expect(store.getThread("t-user-down")?.takenOver).toBe(true);
          for (const threadId of ["t-notified", "t-delegated", "t-compacted"]) {
            expect(store.getThread(threadId)?.takenOver).toBe(false);
            expect(queued).toContainEqual(expect.stringContaining(`Thread ${threadId} completed`));
          }
        }),
      ),
  );

  it.effect("lists the skills a bot wrote and the shared ones, its own winning a name", () =>
    withHarness((h) =>
      Effect.gen(function* () {
        const { botId } = yield* Bots.createBot({ name: "Bot", modelSelection: MODEL });
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
        yield* Bots.sendMessage({ botId, text: "Hi" });
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
      argv: ["chat", "send", "lark/oc_1", "--reply-to", "om_2", "Done,", "--see-above"],
      positional: ["chat", "send", "lark/oc_1", "Done,", "--see-above"],
      flags: { "reply-to": "om_2" },
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
