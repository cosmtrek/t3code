// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off globalTimersInEffect:off tryCatchInEffectGen:off - NodeFS.watch and the cleanup timer outlive any one Effect; the hub they feed is plain TypeScript.
/**
 * Holds the channel hub, the inbox store, and the watcher on delegated context folders for the
 * life of the server. Everything lives under `<stateDir>/channels/`.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import { ChannelHub, type HubEvent } from "../channels/hub.ts";
import { InboxStore } from "./store.ts";

export interface InboxRuntimeShape {
  readonly hub: ChannelHub;
  readonly store: InboxStore;
  readonly channelsDir: string;
  readonly itemsDir: string;
  /** Hub events plus changes to delegated context folders. */
  readonly subscribe: (listener: (event: HubEvent) => void) => () => void;
}

export class InboxRuntime extends Context.Service<InboxRuntime, InboxRuntimeShape>()(
  "t3/fork/inbox/InboxRuntime",
) {}

const MEDIA_RETENTION_MS = 30 * 24 * 3_600_000;
const CLEANUP_INTERVAL_MS = 24 * 3_600_000;
const WATCH_DEBOUNCE_MS = 300;

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await NodeFSP.readdir(dir);
  } catch {
    return [];
  }
}

/** Media lives in each thread's folder: `items/<itemId>/<thread>/media/`. */
async function pruneOldMedia(itemsDir: string, now: number) {
  for (const item of await readDirNames(itemsDir)) {
    for (const thread of await readDirNames(NodePath.join(itemsDir, item))) {
      const mediaDir = NodePath.join(itemsDir, item, thread, "media");
      for (const file of await readDirNames(mediaDir)) {
        const filePath = NodePath.join(mediaDir, file);
        try {
          const stat = await NodeFSP.stat(filePath);
          if (now - stat.mtimeMs > MEDIA_RETENTION_MS) await NodeFSP.rm(filePath, { force: true });
        } catch {
          // Gone already.
        }
      }
    }
  }
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const channelsDir = NodePath.join(config.stateDir, "channels");
  const itemsDir = NodePath.join(channelsDir, "items");
  yield* Effect.promise(() => NodeFSP.mkdir(itemsDir, { recursive: true }));
  const store = new InboxStore(NodePath.join(channelsDir, "inbox.sqlite"));
  const hub = new ChannelHub({ configPath: NodePath.join(channelsDir, "channels.json") });
  const startError = yield* Effect.promise(() =>
    hub.start().then(
      () => null,
      (error: unknown) => String(error),
    ),
  );
  if (startError !== null) {
    yield* Effect.logWarning("Channels could not start; check channels.json.", {
      cause: startError,
    });
  }

  // The thread writes draft.md; the inbox shows it as it lands.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: NodeFS.FSWatcher | null = null;
  try {
    watcher = NodeFS.watch(itemsDir, { recursive: true }, (_event, filename) => {
      const itemId = filename?.toString().split(NodePath.sep)[0];
      if (!itemId || pending.has(itemId)) return;
      const timer = setTimeout(() => {
        pending.delete(itemId);
        const link = store.linksForDelegation(itemId)[0];
        if (link) hub.publish({ type: "inbox", channelId: link.channelId });
      }, WATCH_DEBOUNCE_MS);
      timer.unref?.();
      pending.set(itemId, timer);
    });
    watcher.on("error", () => undefined);
  } catch (error) {
    yield* Effect.logWarning("Cannot watch delegated context folders.", { cause: error });
  }

  void pruneOldMedia(itemsDir, Date.now());
  const cleanup = setInterval(() => void pruneOldMedia(itemsDir, Date.now()), CLEANUP_INTERVAL_MS);
  cleanup.unref?.();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      clearInterval(cleanup);
      for (const timer of pending.values()) clearTimeout(timer);
      watcher?.close();
      hub.stop();
      store.close();
    }),
  );

  return {
    hub,
    store,
    channelsDir,
    itemsDir,
    subscribe: (listener) => hub.subscribe(listener),
  } satisfies InboxRuntimeShape;
});

export const layer = Layer.effect(InboxRuntime, make);
