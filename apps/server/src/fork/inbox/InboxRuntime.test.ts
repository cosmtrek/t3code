// @effect-diagnostics nodeBuiltinImport:off - Native watcher fixtures and independent temporary directories exercise runtime lifecycle.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import { ChannelFileError } from "../channels/config.ts";
import * as ChannelHub from "../channels/hub.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as InboxRuntime from "./InboxRuntime.ts";
import { InboxStore } from "./store.ts";

const io = vi.hoisted(() => ({
  watch: vi.fn(),
  readdir: vi.fn<(path: string) => Promise<string[]>>(),
  stat: vi.fn<(path: string) => Promise<{ mtimeMs: number }>>(),
  rm: vi.fn<(path: string) => Promise<void>>(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  watch: io.watch,
}));

const DAY = 86_400_000;
const NOW = 100 * DAY;

const setup = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inbox-runtime-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      vi.restoreAllMocks();
      const real = await vi.importActual<typeof NodeFSP>("node:fs/promises");
      await real.rm(root, { recursive: true, force: true });
    }),
  );
  const clock = yield* Clock.Clock;
  const sleep = clock.sleep.bind(clock);
  let activeSleeps = 0;
  vi.spyOn(clock, "sleep").mockImplementation((duration) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        activeSleeps++;
      }),
      () => sleep(duration),
      () =>
        Effect.sync(() => {
          activeSleeps--;
        }),
    ),
  );
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const watcher = { close: vi.fn(), on: vi.fn() };
  let notify: (event: string, filename: string) => void = () => undefined;
  io.watch.mockReset().mockImplementation((_path, _options, listener) => {
    notify = listener;
    return watcher;
  });
  io.readdir.mockReset().mockResolvedValue([]);
  io.stat.mockReset();
  io.rm.mockReset().mockResolvedValue(undefined);
  const hub = yield* ChannelHub.make({
    configPath: NodePath.join(root, "channels.json"),
    background: false,
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  );
  const start = vi.spyOn(hub, "start").mockReturnValue(Effect.void);
  const stop = vi.fn(() => hub.stop());
  yield* Scope.addFinalizer(scope, Effect.suspend(stop));
  const close = vi.spyOn(InboxStore.prototype, "close");
  const publish = vi.spyOn(hub, "publish");
  const context = yield* Layer.build(ServerConfig.layerTest(root, root)).pipe(
    Effect.provide(NodeServices.layer),
  );
  const config = Context.get(context, ServerConfig.ServerConfig);
  const nativeFS = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeServices.layer));
  const info = yield* nativeFS.stat(root);
  const failure = (cause: unknown) =>
    PlatformError.systemError({
      _tag: "Unknown",
      module: "FileSystem",
      method: "test",
      pathOrDescriptor: root,
      cause,
    });
  const fs = FileSystem.FileSystem.of({
    ...nativeFS,
    readDirectory: (path) => Effect.tryPromise({ try: () => io.readdir(path), catch: failure }),
    stat: (path) =>
      Effect.tryPromise({ try: () => io.stat(path), catch: failure }).pipe(
        Effect.map(({ mtimeMs }) => ({
          ...info,
          mtime: Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(mtimeMs))),
        })),
      ),
    remove: (path) => Effect.tryPromise({ try: () => io.rm(path), catch: failure }),
  });
  const build = (failDependent = false) =>
    Layer.build(
      failDependent
        ? Layer.effectDiscard(Effect.die("dependent initialization failed")).pipe(
            Layer.provide(InboxRuntime.layer),
          )
        : InboxRuntime.layer,
    ).pipe(
      Effect.provideService(ChannelHub.ChannelHub, hub),
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(Path.layer),
    );
  return {
    activeSleeps: () => activeSleeps,
    build,
    watcher,
    start,
    stop,
    close,
    publish,
    emit: (filename: string) => notify("change", filename),
    shutdown: Scope.close(scope, Exit.void),
  };
});

describe("InboxRuntime lifecycle", () => {
  it.effect("releases the store if hub initialization throws synchronously", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        fixture.start.mockImplementation(() => {
          throw new Error("initialization failed");
        });
        const exit = yield* Effect.exit(fixture.build());
        expect(Exit.isFailure(exit)).toBe(true);
        yield* fixture.shutdown;
        expect(fixture.close).toHaveBeenCalledTimes(1);
      }),
    ),
  );

  it.effect("releases acquired resources when a dependent layer fails to initialize", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        expect(Exit.isFailure(yield* Effect.exit(fixture.build(true)))).toBe(true);
        yield* fixture.shutdown;
        expect(fixture.watcher.close).toHaveBeenCalledTimes(1);
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        expect(fixture.close).toHaveBeenCalledTimes(1);
        expect(fixture.activeSleeps()).toBe(0);
      }),
    ),
  );

  it.effect("coalesces per item for 300ms without extending the first deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        vi.spyOn(InboxStore.prototype, "linksForDelegation").mockImplementation((id) =>
          id === "unlinked"
            ? []
            : [{ channelId: id } as ReturnType<InboxStore["linksForDelegation"]>[number]],
        );
        yield* fixture.build();
        const onError = fixture.watcher.on.mock.calls.find(([event]) => event === "error")?.[1];
        expect(onError).toBeTypeOf("function");
        onError(new Error("watch error"));
        fixture.emit("a/thread/draft.md");
        yield* TestClock.adjust(200);
        fixture.emit("a/thread/draft.md");
        fixture.emit("b/thread/draft.md");
        fixture.emit("unlinked/thread/draft.md");
        yield* TestClock.adjust(99);
        expect(fixture.publish).not.toHaveBeenCalled();
        yield* TestClock.adjust(1);
        expect(fixture.publish.mock.calls).toEqual([[{ type: "inbox", channelId: "a" }]]);
        yield* TestClock.adjust(200);
        expect(fixture.publish.mock.calls).toEqual([
          [{ type: "inbox", channelId: "a" }],
          [{ type: "inbox", channelId: "b" }],
        ]);
        fixture.emit("a/thread/draft.md");
        yield* fixture.shutdown;
        yield* TestClock.adjust(DAY);
        expect(fixture.publish).toHaveBeenCalledTimes(2);
        expect(fixture.watcher.close).toHaveBeenCalledTimes(1);
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        expect(fixture.close).toHaveBeenCalledTimes(1);
        expect(fixture.activeSleeps()).toBe(0);
      }),
    ),
  );

  it.effect(
    "keeps exactly 30 days, removes older media, and repeats daily despite missing directories",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* setup;
          let sweep = Promise.withResolvers<void>();
          io.readdir.mockImplementation(async (path) => {
            if (path.endsWith("/items")) return ["a", "missing"];
            if (path.endsWith("/items/a")) return ["thread"];
            if (path.endsWith("/media")) return ["boundary", "expired"];
            sweep.resolve();
            throw new Error("missing directory");
          });
          io.stat.mockImplementation(async (path) => ({
            mtimeMs: NOW - 30 * DAY - (path.endsWith("expired") ? 1 : 0),
          }));
          yield* fixture.build();
          yield* Effect.promise(() => sweep.promise);
          expect(io.rm.mock.calls.map(([path]) => NodePath.basename(path))).toEqual(["expired"]);
          sweep = Promise.withResolvers<void>();
          yield* TestClock.adjust(DAY - 1);
          expect(io.rm).toHaveBeenCalledTimes(1);
          yield* TestClock.adjust(1);
          yield* Effect.promise(() => sweep.promise);
          expect(io.rm.mock.calls.map(([path]) => NodePath.basename(path))).toEqual([
            "expired",
            "boundary",
            "expired",
          ]);
          sweep = Promise.withResolvers<void>();
          yield* TestClock.adjust(DAY);
          yield* Effect.promise(() => sweep.promise);
          expect(io.rm).toHaveBeenCalledTimes(5);
          yield* fixture.shutdown;
          const reads = io.readdir.mock.calls.length;
          yield* TestClock.adjust(DAY);
          expect(io.readdir).toHaveBeenCalledTimes(reads);
        }),
      ),
  );

  it.effect("degrades on hub start and watch acquisition failures and still closes the store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        fixture.start.mockReturnValue(
          Effect.fail(
            new ChannelFileError({
              message: "invalid channels",
              cause: new Error("invalid channels"),
            }),
          ),
        );
        io.watch.mockImplementation(() => {
          throw new Error("watch unavailable");
        });
        yield* fixture.build();
        yield* fixture.shutdown;
        expect(fixture.close).toHaveBeenCalledTimes(1);
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        expect(fixture.activeSleeps()).toBe(0);
      }),
    ),
  );
});
