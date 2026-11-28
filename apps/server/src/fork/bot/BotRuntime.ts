/**
 * Holds the bot store for the life of the server, under `<stateDir>/bots/`. Nothing is opened
 * until the first bot exists, so an environment without bots runs none of this.
 */

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as BotFiles from "./BotFiles.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as PlatformError from "effect/PlatformError";
import * as BotStore from "./store.ts";

/** `bots` says a bot changed, so views refetch; `bot-activity` carries its turn's latest line. */
export type BotEvent =
  | { readonly type: "bots"; readonly botId: string }
  | {
      readonly type: "bot-activity";
      readonly botId: string;
      readonly threadId: string;
      readonly text: string;
      readonly step?: unknown;
    };

interface Activity {
  readonly threadId: string;
  readonly key: string;
  readonly text: string;
  /** A tool call's item, for clients to label; absent for a message's line. */
  readonly step?: unknown;
  /** The working span it belongs to, by when that started. */
  readonly since: string;
}

export class BotRuntimeError extends Schema.TaggedError<BotRuntimeError>()("BotRuntimeError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "The bot runtime could not acquire its resources.";
  }
}

export class BotRuntime extends Context.Service<
  BotRuntime,
  {
    readonly files: BotFiles.BotFiles["Service"];
    readonly botsDir: string;
    /** The `t3bot` tool, written by `ensureCli`. */
    readonly cliPath: string;
    /** Writes the tool once per server run, so it matches this server. */
    readonly ensureCli: Effect.Effect<void, BotRuntimeError | PlatformError.PlatformError>;
    /** The store, or null while no bot was ever created. */
    readonly existingStore: () => BotStore.BotStore["Service"] | null;
    /** The store, created on first use. */
    readonly store: Effect.Effect<BotStore.BotStore["Service"], BotRuntimeError>;
    /** Opens once a bot exists; event following waits on it. */
    readonly active: Latch.Latch;
    /** Starting and ending turns, one at a time, so a bot never runs two. */
    readonly turnLock: Semaphore.Semaphore;
    /** Thread starts, one at a time, so concurrent starts respect the thread limit. */
    readonly threadStartLock: Semaphore.Semaphore;
    /** Work thread id to bot id, for one lookup per domain event. */
    readonly workThreads: Map<string, string>;
    /** Threads bots started, by id, to the bot that owns each. */
    readonly ownedThreads: Map<string, string>;
    /** By bot: the latest line its work thread or a thread it follows `now` showed, in memory only. */
    readonly activity: Map<string, Activity>;
    readonly publish: (botId: string) => void;
    readonly publishActivity: (botId: string, activity: Activity) => void;
    readonly subscribe: (listener: (event: BotEvent) => void) => () => void;
  }
>()("t3/fork/bot/BotRuntime") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const scope = yield* Scope.Scope;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* BotFiles.BotFiles;
  const botsDir = path.join(config.stateDir, "bots");
  const storePath = path.join(botsDir, "bots.sqlite");
  let store: BotStore.BotStore["Service"] | null = null;
  let closed = false;
  const resourceLock = yield* Semaphore.make(1);
  yield* Effect.addFinalizer(() =>
    resourceLock.withPermit(
      Effect.sync(() => {
        closed = true;
        store = null;
      }),
    ),
  );
  const getStore = resourceLock.withPermit(
    Effect.gen(function* () {
      if (closed)
        return yield* new BotRuntimeError({ cause: new Error("The bot runtime is closed.") });
      store ??= yield* BotStore.make(storePath).pipe(
        Scope.provide(scope),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) => new BotRuntimeError({ cause })),
      );
      return store;
    }),
  );
  if (yield* fs.exists(storePath).pipe(Effect.orElseSucceed(() => false))) yield* getStore;
  const restored = yield* Effect.gen(function* () {
    const existing = store;
    return {
      bots: existing === null ? [] : yield* existing.listBots(),
      threads: existing === null ? [] : yield* existing.listThreads(),
    };
  }).pipe(Effect.mapError((cause) => new BotRuntimeError({ cause })));
  const workThreads = new Map<string, string>();
  for (const bot of restored.bots) {
    if (bot.workThreadId !== null && bot.workProjectId !== null)
      workThreads.set(bot.workThreadId, bot.id);
  }
  const ownedThreads = new Map(
    restored.threads.map((thread) => [thread.threadId, thread.botId] as const),
  );
  const active = yield* Latch.make(restored.bots.length > 0);
  const turnLock = yield* Semaphore.make(1);
  const threadStartLock = yield* Semaphore.make(1);
  const listeners = new Set<(event: BotEvent) => void>();
  const activity = new Map<string, Activity>();
  let cliWritten = false;

  return {
    botsDir,
    files,
    cliPath: path.join(botsDir, "bin", "t3bot"),
    ensureCli: Effect.suspend(() =>
      closed
        ? Effect.fail(new BotRuntimeError({ cause: new Error("The bot runtime is closed.") }))
        : resourceLock
            .withPermit(
              Effect.gen(function* () {
                if (closed)
                  return yield* new BotRuntimeError({
                    cause: new Error("The bot runtime is closed."),
                  });
                if (cliWritten) return;
                yield* files.writeCli(botsDir, config.stateDir);
                cliWritten = true;
              }),
            )
            .pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    ),
    existingStore: () => store,
    store: Effect.suspend(() =>
      closed
        ? Effect.fail(new BotRuntimeError({ cause: new Error("The bot runtime is closed.") }))
        : getStore.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    ),
    active,
    turnLock,
    threadStartLock,
    workThreads,
    ownedThreads,
    activity,
    publish: (botId) => {
      for (const listener of listeners) listener({ type: "bots", botId });
    },
    publishActivity: (botId, latest) => {
      activity.set(botId, latest);
      const { threadId, text, step } = latest;
      for (const listener of listeners) {
        listener({
          type: "bot-activity",
          botId,
          threadId,
          text,
          ...(step === undefined ? {} : { step }),
        });
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies BotRuntime["Service"];
});

export const layer = Layer.effect(BotRuntime, make);
