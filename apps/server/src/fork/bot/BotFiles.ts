// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tokens retain their existing 32-byte hex encoding.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { cliFiles } from "./cli.ts";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly shared: boolean;
  readonly folder: string;
  readonly path: string;
}
export interface NoteFile {
  readonly name: string;
  readonly bytes: number;
  readonly updatedAt: string;
}

export class BotFiles extends Context.Service<
  BotFiles,
  {
    readonly workspacePath: (botsDir: string, botId: string) => string;
    readonly notesPath: (botsDir: string, botId: string) => string;
    readonly ownSkillsPath: (botsDir: string, botId: string) => string;
    readonly sharedSkillsPath: (botsDir: string) => string;
    readonly writeCli: (
      botsDir: string,
      stateDir: string,
    ) => Effect.Effect<string, PlatformError.PlatformError>;
    readonly ensureWorkspace: (
      botsDir: string,
      botId: string,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly writeToken: (
      botsDir: string,
      botId: string,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly readToken: (botsDir: string, botId: string) => Effect.Effect<string | null>;
    readonly readRole: (botsDir: string, botId: string) => Effect.Effect<string>;
    readonly writeRole: (
      botsDir: string,
      botId: string,
      role: string,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly removeBot: (
      botsDir: string,
      botId: string,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly listNotes: (
      botsDir: string,
      botId: string,
    ) => Effect.Effect<ReadonlyArray<NoteFile>, PlatformError.PlatformError>;
    readonly listSkills: (botsDir: string, botId: string) => Effect.Effect<ReadonlyArray<Skill>>;
    readonly readNote: (base: string, name: string, skill: boolean) => Effect.Effect<string | null>;
    readonly validName: (name: string) => boolean;
  }
>()("t3/fork/bot/BotFiles") {}

const parseSkillFrontmatter = (text: string) => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.*)$`, "m")
      .exec(block)?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/, "$2") ?? "";
  return { name: field("name"), description: field("description") };
};

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePath = (dir: string, id: string) => path.join(dir, id, "workspace");
  const notesPath = (dir: string, id: string) => path.join(workspacePath(dir, id), "notes");
  const ownSkillsPath = (dir: string, id: string) => path.join(workspacePath(dir, id), "skills");
  const sharedSkillsPath = (dir: string) => path.join(dir, "skills");
  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  const listIn = Effect.fn("BotFiles.listSkillsIn")(function* (dir: string, shared: boolean) {
    const entries = yield* fs.readDirectoryEntries(dir).pipe(Effect.orElseSucceed(() => []));
    const skills = yield* Effect.forEach(
      entries.filter((entry) => entry.type === "Directory" && !entry.name.startsWith(".")),
      (entry) =>
        Effect.gen(function* () {
          const file = path.join(dir, entry.name, "SKILL.md");
          const text = yield* readText(file);
          if (text === null) return null;
          const meta = parseSkillFrontmatter(text);
          return {
            name: meta.name || entry.name,
            description: meta.description.slice(0, 300),
            shared,
            folder: entry.name,
            path: file,
          };
        }),
      { concurrency: "unbounded" },
    );
    return skills.filter((skill) => skill !== null);
  });
  return BotFiles.of({
    workspacePath,
    notesPath,
    ownSkillsPath,
    sharedSkillsPath,
    validName: (name) => path.basename(name) === name && !name.startsWith("."),
    writeCli: Effect.fn("BotFiles.writeCli")(function* (botsDir, stateDir) {
      const binDir = path.join(botsDir, "bin");
      yield* fs.makeDirectory(binDir, { recursive: true });
      for (const file of cliFiles(botsDir, stateDir, path.join(binDir, "t3bot.mjs"))) {
        yield* fs.writeFileString(
          path.join(binDir, file.name),
          file.content,
          file.mode === undefined ? undefined : { mode: file.mode },
        );
      }
      return path.join(binDir, "t3bot");
    }),
    ensureWorkspace: Effect.fn("BotFiles.ensureWorkspace")(function* (dir, id) {
      for (const folder of [notesPath(dir, id), ownSkillsPath(dir, id), sharedSkillsPath(dir)])
        yield* fs.makeDirectory(folder, { recursive: true });
    }),
    writeToken: Effect.fn("BotFiles.writeToken")((dir, id) =>
      Effect.suspend(() =>
        fs.writeFileString(
          path.join(dir, id, "token"),
          NodeCrypto.randomBytes(32).toString("hex"),
          { mode: 0o600, flag: "wx" },
        ),
      ).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      ),
    ),
    readToken: Effect.fn("BotFiles.readToken")((dir, id) =>
      readText(path.join(dir, id, "token")).pipe(Effect.map((text) => text?.trim() ?? null)),
    ),
    readRole: Effect.fn("BotFiles.readRole")((dir, id) =>
      readText(path.join(dir, id, "role.md")).pipe(Effect.map((text) => text ?? "")),
    ),
    writeRole: Effect.fn("BotFiles.writeRole")((dir, id, role) =>
      fs.writeFileString(path.join(dir, id, "role.md"), role),
    ),
    removeBot: Effect.fn("BotFiles.removeBot")((dir, id) =>
      fs.remove(path.join(dir, id), { recursive: true, force: true }),
    ),
    listNotes: Effect.fn("BotFiles.listNotes")(function* (dir, id) {
      const base = notesPath(dir, id);
      const entries = yield* fs.readDirectoryEntries(base).pipe(Effect.orElseSucceed(() => []));
      const notes = yield* Effect.forEach(
        entries.filter((entry) => entry.type === "File" && !entry.name.startsWith(".")),
        (entry) =>
          Effect.gen(function* () {
            const stat = yield* fs.stat(path.join(base, entry.name));
            return {
              name: entry.name,
              bytes: Number(stat.size),
              updatedAt: Option.getOrThrow(stat.mtime).toISOString(),
            };
          }),
        { concurrency: "unbounded" },
      );
      return notes
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 50);
    }),
    listSkills: Effect.fn("BotFiles.listSkills")(function* (dir, id) {
      const own = yield* listIn(ownSkillsPath(dir, id), false);
      const names = new Set(own.map((skill) => skill.name));
      const shared = (yield* listIn(sharedSkillsPath(dir), true)).filter(
        (skill) => !names.has(skill.name),
      );
      return [...own, ...shared]
        .toSorted(
          (left, right) =>
            Number(left.shared) - Number(right.shared) || left.name.localeCompare(right.name),
        )
        .slice(0, 40);
    }),
    readNote: Effect.fn("BotFiles.readNote")((base, name, skill) =>
      Effect.gen(function* () {
        const file = skill ? path.join(base, name, "SKILL.md") : path.join(base, name);
        const [root, real] = yield* Effect.all([fs.realPath(base), fs.realPath(file)], {
          concurrency: "unbounded",
        });
        if (!real.startsWith(root + path.sep)) return null;
        return yield* fs.readFileString(real);
      }).pipe(Effect.orElseSucceed(() => null)),
    ),
  });
});

export const layer = Layer.effect(BotFiles, make);
