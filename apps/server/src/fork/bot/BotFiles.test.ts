// @effect-diagnostics nodeBuiltinImport:off -- Temporary native files verify token flags and symlink containment.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as BotFiles from "./BotFiles.ts";

it.effect("keeps exclusive owner-only tokens and confines note and skill links", () =>
  Effect.gen(function* () {
    const files = yield* BotFiles.BotFiles;
    const fs = yield* FileSystem.FileSystem;
    const root = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-files-")),
    );
    yield* Effect.addFinalizer(() =>
      fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    yield* files.ensureWorkspace(root, "b1");
    yield* Effect.all([files.writeToken(root, "b1"), files.writeToken(root, "b1")], {
      concurrency: "unbounded",
    });
    const token = yield* files.readToken(root, "b1");
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((yield* fs.stat(NodePath.join(root, "b1", "token"))).mode & 0o777).toBe(0o600);
    yield* files.writeToken(root, "b1");
    expect(yield* files.readToken(root, "b1")).toBe(token);
    const notes = files.notesPath(root, "b1");
    const skills = files.ownSkillsPath(root, "b1");
    yield* fs.writeFileString(NodePath.join(root, "secret"), "outside");
    yield* fs.writeFileString(NodePath.join(notes, "ok.md"), "inside");
    yield* Effect.promise(async () => {
      await NodeFSP.symlink(NodePath.join(root, "secret"), NodePath.join(notes, "escape.md"));
      await NodeFSP.symlink(NodePath.join(notes, "ok.md"), NodePath.join(notes, "inside.md"));
      await NodeFSP.symlink(root, NodePath.join(skills, "escape"));
      await NodeFSP.writeFile(NodePath.join(root, "SKILL.md"), "outside skill");
    });
    expect(yield* files.readNote(notes, "escape.md", false)).toBeNull();
    expect(yield* files.readNote(notes, "inside.md", false)).toBe("inside");
    expect(yield* files.readNote(skills, "escape", true)).toBeNull();
    expect((yield* files.listNotes(root, "b1")).map((note) => note.name)).toEqual(["ok.md"]);
    expect(yield* files.listSkills(root, "b1")).toEqual([]);
  }).pipe(
    Effect.scoped,
    Effect.provide(BotFiles.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
