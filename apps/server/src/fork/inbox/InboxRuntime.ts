/**
 * Holds the channel hub, the inbox store, and the watcher on delegated context folders for the
 * life of the server. Everything lives under `<stateDir>/channels/`.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - Native watch keeps notifying after errors; FileSystem.watch ends its stream.
import * as NodeFS from "node:fs";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

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

const pruneOldMedia = Effect.fn("InboxRuntime.pruneOldMedia")(function* (itemsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;
  const readNames = (dir: string) => fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  for (const item of yield* readNames(itemsDir)) {
    for (const thread of yield* readNames(path.join(itemsDir, item))) {
      const mediaDir = path.join(itemsDir, item, thread, "media");
      for (const file of yield* readNames(mediaDir)) {
        const filePath = path.join(mediaDir, file);
        yield* fs.stat(filePath).pipe(
          Effect.flatMap((stat) =>
            Option.exists(stat.mtime, (mtime) => now - mtime.getTime() > MEDIA_RETENTION_MS)
              ? fs.remove(filePath, { force: true })
              : Effect.void,
          ),
          Effect.ignore,
        );
      }
    }
  }
});

const watchFolders = (itemsDir: string, ready: Deferred.Deferred<void>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      return Stream.callback<
        { readonly filename: string; readonly at: number },
        PlatformError.PlatformError
      >((events) =>
        Effect.acquireRelease(
          Effect.try({
            try: () =>
              NodeFS.watch(itemsDir, { recursive: true }, (_event, filename) => {
                if (filename !== null)
                  Queue.offerUnsafe(events, {
                    filename: filename.toString(),
                    at: clock.currentTimeMillisUnsafe(),
                  });
              }),
            catch: (cause) =>
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "watch",
                pathOrDescriptor: itemsDir,
                cause,
              }),
          }),
          (watcher) => Effect.sync(() => watcher.close()),
        ).pipe(
          Effect.tap((watcher) =>
            Effect.sync(() => {
              watcher.on("error", () => undefined);
            }),
          ),
          Effect.ensuring(Deferred.succeed(ready, undefined)),
        ),
      );
    }),
  );

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const channelsDir = path.join(config.stateDir, "channels");
  const itemsDir = path.join(channelsDir, "items");
  yield* fs.makeDirectory(itemsDir, { recursive: true });
  const store = yield* Effect.acquireRelease(
    Effect.sync(() => new InboxStore(path.join(channelsDir, "inbox.sqlite"))),
    (store) => Effect.sync(() => store.close()),
  );
  const hub = yield* Effect.acquireRelease(
    Effect.sync(() => new ChannelHub({ configPath: path.join(channelsDir, "channels.json") })),
    (hub) => Effect.sync(() => hub.stop()),
  );
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

  const pending = new Set<string>();
  const ready = yield* Deferred.make<void>();
  yield* watchFolders(itemsDir, ready).pipe(
    Stream.runForEach(({ filename, at }) =>
      Effect.gen(function* () {
        const itemId = filename.split(path.sep)[0];
        if (!itemId || pending.has(itemId)) return;
        pending.add(itemId);
        const remaining = Math.max(0, at + WATCH_DEBOUNCE_MS - (yield* Clock.currentTimeMillis));
        yield* Effect.sleep(remaining).pipe(
          Effect.andThen(
            Effect.sync(() => {
              pending.delete(itemId);
              const link = store.linksForDelegation(itemId)[0];
              if (link) hub.publish({ type: "inbox", channelId: link.channelId });
            }),
          ),
          Effect.forkIn(scope),
        );
      }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Cannot watch delegated context folders.", { cause }),
    ),
    Effect.forkScoped,
  );
  yield* Deferred.await(ready);
  yield* pruneOldMedia(itemsDir).pipe(
    Effect.repeat(Schedule.fixed(CLEANUP_INTERVAL_MS)),
    Effect.forkScoped,
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
