import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Artifacts from "./artifacts.ts";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "inbox-artifacts-" });
  const build = (fileSystem = fs) =>
    Artifacts.Artifacts.pipe(
      Effect.provide(Artifacts.layer),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  const error = PlatformError.systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method: "writeFile",
    pathOrDescriptor: dir,
    cause: new Error("injected"),
  });
  return { fs, dir, build, error };
});

describe("Artifacts recovery", () => {
  it.effect("restores the draft when interrupted after rename and releases the folder lock", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const moved = yield* Deferred.make<void>();
      let paused = false;
      const files = yield* h.build(
        FileSystem.FileSystem.of({
          ...h.fs,
          readFileString: (file, encoding) => {
            if (file.endsWith(".aside") && !paused) {
              paused = true;
              return Deferred.succeed(moved, undefined).pipe(Effect.andThen(Effect.never));
            }
            return h.fs.readFileString(file, encoding);
          },
        }),
      );
      yield* files.applyFallback(h.dir, "first", "original");
      const writer = yield* files
        .applyFallback(h.dir, "second", "replacement")
        .pipe(Effect.forkChild);
      yield* Deferred.await(moved);
      yield* Fiber.interrupt(writer);
      expect(yield* files.readArtifacts(h.dir)).toEqual({ draft: "original" });
      expect((yield* h.fs.readDirectory(h.dir)).filter((name) => name.endsWith(".aside"))).toEqual(
        [],
      );
      yield* files.applyFallback(h.dir, "third", "later");
      expect(yield* files.readArtifacts(h.dir)).toEqual({ draft: "later" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the recovery copy when rollback fails or another writer owns the target", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      for (const competing of [false, true]) {
        const dir = `${h.dir}/${competing}`;
        yield* h.fs.makeDirectory(dir);
        let armed = false;
        const files = yield* h.build(
          FileSystem.FileSystem.of({
            ...h.fs,
            writeFileString: (file, content, options) => {
              if (armed && file === `${dir}/draft.md`)
                return Effect.gen(function* () {
                  if (competing) {
                    armed = false;
                    yield* h.fs.writeFileString(file, "thread wrote\n", { flag: "wx" });
                  }
                  return yield* h.error;
                });
              return h.fs.writeFileString(file, content, options);
            },
          }),
        );
        yield* files.applyFallback(dir, "first", "original");
        armed = true;
        expect(
          Result.isFailure(yield* Effect.result(files.applyFallback(dir, "second", "replacement"))),
        ).toBe(true);
        const aside = (yield* h.fs.readDirectory(dir)).find((name) => name.endsWith(".aside"));
        expect(aside).toBeDefined();
        expect(yield* h.fs.readFileString(`${dir}/${aside}`)).toBe("original\n");
        expect(yield* files.readArtifacts(dir)).toEqual({
          draft: competing ? "thread wrote" : null,
        });
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does not share folder locks between fork instances", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const first = yield* h.build();
      const second = yield* h.build();
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const pending = yield* first
        .applyFallback(h.dir, "first", "first", {
          beforeWrite: () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* second.applyFallback(h.dir, "second", "second");
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(pending);
      expect(yield* first.readArtifacts(h.dir)).toEqual({ draft: "second" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes archiving a sent draft before honoring interruption", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const archived = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const files = yield* h.build(
        FileSystem.FileSystem.of({
          ...h.fs,
          writeFileString: (file, content, options) =>
            h.fs
              .writeFileString(file, content, options)
              .pipe(
                Effect.tap(() =>
                  file.includes("/sent.")
                    ? Deferred.succeed(archived, undefined).pipe(
                        Effect.andThen(Deferred.await(resume)),
                      )
                    : Effect.void,
                ),
              ),
        }),
      );
      yield* files.applyFallback(h.dir, "first", "original");
      const writer = yield* files
        .recordSent({
          itemDir: h.dir,
          draftDir: h.dir,
          draftAtSend: "original",
          text: "edited",
          messageId: "message",
          sentAt: "2026-11-28T00:00:00.000Z",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(archived);
      yield* Effect.sync(() => writer.interruptUnsafe());
      yield* Deferred.succeed(resume, undefined);
      expect(Exit.isFailure(yield* Fiber.await(writer))).toBe(true);
      expect(yield* files.readSent(h.dir)).toEqual([
        { sentAt: "2026-11-28T00:00:00.000Z", source: "edited draft", text: "edited" },
      ]);
      expect(yield* h.fs.readFileString(`${h.dir}/draft.2026-11-28T00-00-00-000Z.md`)).toBe(
        "original\n",
      );
      expect(yield* files.readArtifacts(h.dir)).toEqual({ draft: null });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
