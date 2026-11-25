// @effect-diagnostics nodeBuiltinImport:off - node:fs checks for the store file before opening it.
/**
 * Holds the bot store for the life of the server, under `<stateDir>/bots/`. Nothing is opened
 * until the first bot exists, so an environment without bots runs none of this.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import { writeCli } from "./cli.ts";
import { BotStore } from "./store.ts";

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

export interface BotRuntimeShape {
  readonly botsDir: string;
  /** The `t3bot` tool, written by `ensureCli`. */
  readonly cliPath: string;
  /** Writes the tool once per server run, so it matches this server. */
  readonly ensureCli: Effect.Effect<void>;
  /** The store, or null while no bot was ever created. */
  readonly existingStore: () => BotStore | null;
  /** The store, created on first use. */
  readonly store: () => BotStore;
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

export class BotRuntime extends Context.Service<BotRuntime, BotRuntimeShape>()(
  "t3/fork/bot/BotRuntime",
) {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const botsDir = NodePath.join(config.stateDir, "bots");
  const storePath = NodePath.join(botsDir, "bots.sqlite");
  let store: BotStore | null = NodeFS.existsSync(storePath) ? new BotStore(storePath) : null;
  const workThreads = new Map<string, string>();
  for (const bot of store?.listBots() ?? []) {
    if (bot.workThreadId !== null) workThreads.set(bot.workThreadId, bot.id);
  }
  const ownedThreads = new Map(
    (store?.listThreads() ?? []).map((thread) => [thread.threadId, thread.botId] as const),
  );
  const active = yield* Latch.make((store?.listBots().length ?? 0) > 0);
  const turnLock = yield* Semaphore.make(1);
  const threadStartLock = yield* Semaphore.make(1);
  const listeners = new Set<(event: BotEvent) => void>();
  const activity = new Map<string, Activity>();
  let cliWritten = false;

  yield* Effect.addFinalizer(() => Effect.sync(() => store?.close()));

  return {
    botsDir,
    cliPath: NodePath.join(botsDir, "bin", "t3bot"),
    ensureCli: Effect.suspend(() =>
      cliWritten
        ? Effect.void
        : Effect.promise(() => writeCli(botsDir, config.stateDir)).pipe(
            Effect.tap(() => Effect.sync(() => (cliWritten = true))),
            Effect.asVoid,
          ),
    ),
    existingStore: () => store,
    store: () => {
      store ??= new BotStore(storePath);
      return store;
    },
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
  } satisfies BotRuntimeShape;
});

export const layer = Layer.effect(BotRuntime, make);
