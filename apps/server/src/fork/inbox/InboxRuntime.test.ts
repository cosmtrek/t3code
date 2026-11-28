// @effect-diagnostics nodeBuiltinImport:off - Native timer and watcher fixtures exercise the pre-migration runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import { ChannelHub } from "../channels/hub.ts";
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
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readdir: io.readdir,
  stat: io.stat,
  rm: io.rm,
}));

const DAY = 86_400_000;
const NOW = 100 * DAY;

const setup = Effect.gen(function* () {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  vi.setSystemTime(NOW);
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inbox-runtime-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      vi.restoreAllMocks();
      vi.useRealTimers();
      const real = await vi.importActual<typeof NodeFSP>("node:fs/promises");
      await real.rm(root, { recursive: true, force: true });
    }),
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
  const start = vi.spyOn(ChannelHub.prototype, "start").mockResolvedValue(undefined);
  const stop = vi.spyOn(ChannelHub.prototype, "stop");
  const close = vi.spyOn(InboxStore.prototype, "close");
  const publish = vi.spyOn(ChannelHub.prototype, "publish");
  const context = yield* Layer.build(ServerConfig.layerTest(root, root)).pipe(
    Effect.provide(NodeServices.layer),
  );
  const config = Context.get(context, ServerConfig.ServerConfig);
  const build = (failDependent = false) =>
    Layer.build(
      failDependent
        ? Layer.effectDiscard(Effect.die("dependent initialization failed")).pipe(
            Layer.provide(InboxRuntime.layer),
          )
        : InboxRuntime.layer,
    ).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(Scope.Scope, scope),
    );
  return {
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
  // Known defect: acquisition registers store cleanup only after hub.start; fixed in S2.
  it.live.fails("releases the store if hub initialization throws synchronously", () =>
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

  it.live("releases acquired resources when a dependent layer fails to initialize", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        expect(Exit.isFailure(yield* Effect.exit(fixture.build(true)))).toBe(true);
        yield* fixture.shutdown;
        expect(fixture.watcher.close).toHaveBeenCalledTimes(1);
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        expect(fixture.close).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }),
    ),
  );

  it.live("coalesces per item for 300ms without extending the first deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        vi.spyOn(InboxStore.prototype, "linksForDelegation").mockImplementation((id) =>
          id === "unlinked"
            ? []
            : [{ channelId: id } as ReturnType<InboxStore["linksForDelegation"]>[number]],
        );
        yield* fixture.build();
        fixture.emit("a/thread/draft.md");
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(200));
        fixture.emit("a/thread/draft.md");
        fixture.emit("b/thread/draft.md");
        fixture.emit("unlinked/thread/draft.md");
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(99));
        expect(fixture.publish).not.toHaveBeenCalled();
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
        expect(fixture.publish.mock.calls).toEqual([[{ type: "inbox", channelId: "a" }]]);
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(200));
        expect(fixture.publish.mock.calls).toEqual([
          [{ type: "inbox", channelId: "a" }],
          [{ type: "inbox", channelId: "b" }],
        ]);
        fixture.emit("a/thread/draft.md");
        yield* fixture.shutdown;
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(DAY));
        expect(fixture.publish).toHaveBeenCalledTimes(2);
        expect(fixture.watcher.close).toHaveBeenCalledTimes(1);
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        expect(fixture.close).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }),
    ),
  );

  it.live(
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
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(DAY - 1));
          expect(io.rm).toHaveBeenCalledTimes(1);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          yield* Effect.promise(() => sweep.promise);
          expect(io.rm.mock.calls.map(([path]) => NodePath.basename(path))).toEqual([
            "expired",
            "boundary",
            "expired",
          ]);
          sweep = Promise.withResolvers<void>();
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(DAY));
          yield* Effect.promise(() => sweep.promise);
          expect(io.rm).toHaveBeenCalledTimes(5);
          yield* fixture.shutdown;
          const reads = io.readdir.mock.calls.length;
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(DAY));
          expect(io.readdir).toHaveBeenCalledTimes(reads);
        }),
      ),
  );

  it.live("degrades on hub start and watch acquisition failures and still closes the store", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* setup;
        fixture.start.mockRejectedValue(new Error("invalid channels"));
        io.watch.mockImplementation(() => {
          throw new Error("watch unavailable");
        });
        yield* fixture.build();
        yield* fixture.shutdown;
        expect(fixture.close).toHaveBeenCalledTimes(1);
        expect(fixture.stop).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }),
    ),
  );
});
