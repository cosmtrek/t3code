// @effect-diagnostics nodeBuiltinImport:off - Bots keep their role in a temporary folder.
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

import * as ServerConfig from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import { ManagedProjectFolders } from "../../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { BotRuntime, type BotRuntimeShape } from "./BotRuntime.ts";
import * as Bots from "./operations.ts";
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
  | FileSystem.FileSystem;

async function harness(store = new BotStore(":memory:")): Promise<Harness> {
  const botsDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bots-"));
  const runtime: BotRuntimeShape = {
    botsDir,
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
  const nextRun = (threadId: string) => {
    const runId = `run-${runs.length + 1}`;
    runs.push({ threadId, runId });
    runStatus.set(runId, "running");
    return runId;
  };
  const layer = Layer.mergeAll(
    Layer.succeed(BotRuntime, runtime),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      sendToThread: (input) => {
        packets.push(input.text);
        return Effect.succeed({ run: { id: nextRun(input.threadId) } } as never);
      },
      getProjectThreadRecords: (_input, _fields, filter) =>
        Effect.succeed({
          runs: (filter?.runIds ?? []).flatMap((id) =>
            runStatus.has(id) ? [{ id, status: runStatus.get(id) }] : [],
          ),
          messages: (filter?.messageRunIds ?? []).flatMap((id) =>
            replies.has(id) ? [{ text: replies.get(id), createdAt: DateTime.makeUnsafe(0) }] : [],
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
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.succeed(ServerConfig.ServerConfig, {} as never),
    FileSystem.layerNoop({}),
  );
  return { runtime, packets, runs, runStatus, replies, layer };
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
    Effect.flatMap((h) => program(h).pipe(Effect.provide(h.layer))),
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
        const [context, fresh] = h.packets[1]!.split("New from the user:");
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
    store.startTurn({ botId: "bot_1", runId: "run-down", threadId: "thread-1", startedAt: "t1" }, [
      "m1",
    ]);
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
});
