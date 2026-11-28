// @effect-diagnostics nodeBuiltinImport:off -- Real temporary files and database handles verify acquisition and cleanup.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as BotFiles from "./BotFiles.ts";
import * as BotRuntime from "./BotRuntime.ts";
import { BotStore } from "./store.ts";

const setup = Effect.gen(function* () {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-runtime-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const fs = yield* FileSystem.FileSystem;
  const build = (fileSystem = fs) =>
    Layer.build(
      BotRuntime.layer.pipe(
        Layer.provide(BotFiles.layer),
        Layer.provide(ServerConfig.layerTest(root, root)),
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
      ),
    ).pipe(
      Scope.provide(scope),
      Effect.map((context) => Context.get(context, BotRuntime.BotRuntime)),
    );
  return { root, scope, fs, build };
});

describe("BotRuntime", () => {
  it.effect("opens the lazy store once and closes it with the owning scope", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      using close = vi.spyOn(BotStore.prototype, "close");
      const runtime = yield* h.build();
      expect(runtime.existingStore()).toBeNull();
      expect(yield* h.fs.exists(runtime.botsDir)).toBe(false);
      const stores = yield* Effect.all([runtime.store, runtime.store], {
        concurrency: "unbounded",
      });
      expect(stores[0]).toBe(stores[1]);
      yield* Scope.close(h.scope, Exit.void);
      expect(close).toHaveBeenCalledTimes(1);
      expect(runtime.existingStore()).toBeNull();
      expect(Exit.isFailure(yield* Effect.exit(runtime.store))).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("shares concurrent CLI writes and retries a typed write failure", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const failure = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "writeFile",
        pathOrDescriptor: h.root,
        cause: new Error("injected"),
      });
      const runtime = yield* h.build(
        FileSystem.FileSystem.of({
          ...h.fs,
          writeFileString: (file, data, options) =>
            Effect.gen(function* () {
              if (file.endsWith("t3bot.mjs")) {
                calls++;
                if (calls === 1) {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                  return yield* failure;
                }
              }
              return yield* h.fs.writeFileString(file, data, options);
            }),
        }),
      );
      const first = yield* runtime.ensureCli.pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* runtime.ensureCli.pipe(Effect.forkChild);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(first);
      expect(Result.isFailure(result)).toBe(true);
      yield* Fiber.join(second);
      yield* Effect.all([runtime.ensureCli, runtime.ensureCli], { concurrency: "unbounded" });
      expect(calls).toBe(2);
      expect(yield* h.fs.exists(runtime.cliPath)).toBe(true);
      yield* Scope.close(h.scope, Exit.void);
      expect(Exit.isFailure(yield* Effect.exit(runtime.ensureCli))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("releases a failed lazy store and allows the next acquisition to retry", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const runtime = yield* h.build();
      yield* h.fs.makeDirectory(runtime.botsDir, { recursive: true });
      const file = NodePath.join(runtime.botsDir, "bots.sqlite");
      const seed = new NodeSqlite.DatabaseSync(file);
      seed.exec("PRAGMA user_version = 999999");
      seed.close();
      using close = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "close");
      expect(Result.isFailure(yield* Effect.result(runtime.store))).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
      expect(runtime.existingStore()).toBeNull();
      yield* h.fs.remove(file);
      const store = yield* runtime.store;
      expect(store.listBots()).toEqual([]);
      yield* Scope.close(h.scope, Exit.void);
      expect(close).toHaveBeenCalledTimes(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes the CLI once across concurrent first requests", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      let calls = 0;
      const runtime = yield* h.build(
        FileSystem.FileSystem.of({
          ...h.fs,
          writeFileString: (file, data, options) =>
            Effect.gen(function* () {
              if (file.endsWith("t3bot.mjs")) calls++;
              return yield* h.fs.writeFileString(file, data, options);
            }),
        }),
      );
      yield* Effect.all([runtime.ensureCli, runtime.ensureCli, runtime.ensureCli], {
        concurrency: "unbounded",
      });
      expect(calls).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("interrupts pending CLI acquisition when its scope closes", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const started = yield* Deferred.make<void>();
      let released = false;
      const runtime = yield* h.build(
        FileSystem.FileSystem.of({
          ...h.fs,
          writeFileString: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
        }),
      );
      const writer = yield* runtime.ensureCli.pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(started);
      yield* Scope.close(h.scope, Exit.void);
      expect(released).toBe(true);
      expect(Exit.isFailure(yield* Fiber.join(writer))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("releases an existing store when startup indexing fails", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const seed = new BotStore(NodePath.join(h.root, "userdata", "bots", "bots.sqlite"));
      seed.close();
      using close = vi.spyOn(BotStore.prototype, "close");
      using _list = vi.spyOn(BotStore.prototype, "listBots").mockImplementation(() => {
        throw new Error("indexing failed");
      });
      expect(Exit.isFailure(yield* Effect.exit(h.build()))).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("closes a database whose constructor rejects its schema", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* h.fs.makeDirectory(NodePath.join(h.root, "userdata", "bots"), { recursive: true });
      const seed = new NodeSqlite.DatabaseSync(
        NodePath.join(h.root, "userdata", "bots", "bots.sqlite"),
      );
      seed.exec("PRAGMA user_version = 999999");
      seed.close();
      using close = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "close");
      expect(Exit.isFailure(yield* Effect.exit(h.build()))).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
