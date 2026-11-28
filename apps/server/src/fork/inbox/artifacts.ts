// @effect-diagnostics-next-line nodeBuiltinImport:off -- Persisted ownership hashes and sent filenames retain SHA256 hex encoding.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

import { DRAFT_FILE } from "./context.ts";

const FALLBACK_RECORD = ".fallback.json";
const meaningful = (text: string | null) =>
  text !== null && text.trim().length > 0 ? text.trim() : null;
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

type Restore = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
interface FallbackRecord {
  readonly runId: string;
  readonly files: Readonly<Record<string, string>>;
}
interface FallbackOptions {
  readonly beforeWrite?: (fileName: string) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly onQueued?: () => void;
}
export type SentSource = "draft" | "edited draft" | "typed";
export interface SentRecord {
  readonly sentAt: string;
  readonly source: SentSource;
  readonly text: string;
}
interface SentInput {
  readonly itemDir: string;
  readonly draftDir: string | null;
  readonly draftAtSend: string | null;
  readonly text: string;
  readonly files?: ReadonlyArray<string>;
  readonly messageId: string;
  readonly sentAt: string;
}
const SOURCES: ReadonlyArray<SentSource> = ["draft", "edited draft", "typed"];

export class Artifacts extends Context.Service<
  Artifacts,
  {
    readonly threadContextDir: (itemsDir: string, itemId: string, threadId: string) => string;
    readonly readArtifacts: (dir: string) => Effect.Effect<{ readonly draft: string | null }>;
    readonly fallbackApplied: (dir: string, runId: string) => Effect.Effect<boolean>;
    readonly applyFallback: (
      dir: string,
      runId: string,
      draft: string | null,
      options?: FallbackOptions,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
    readonly recordSent: (
      input: SentInput,
    ) => Effect.Effect<SentSource, PlatformError.PlatformError>;
    readonly discardDraft: (
      dir: string,
      shown: string,
      at: string,
    ) => Effect.Effect<boolean, PlatformError.PlatformError>;
    readonly readSent: (dir: string) => Effect.Effect<ReadonlyArray<SentRecord>>;
  }
>()("t3/fork/inbox/artifacts") {}

const parseRecord = (text: string): FallbackRecord | null => {
  try {
    const value = JSON.parse(text) as Partial<FallbackRecord>;
    return typeof value.runId === "string" && typeof value.files === "object" && value.files
      ? { runId: value.runId, files: value.files }
      : null;
  } catch {
    return null;
  }
};
const recordText = (record: FallbackRecord) => `${JSON.stringify(record)}\n`;
const sentMessageId = (messageId: string) => `messageId: ${JSON.stringify(messageId)}`;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folders = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();
  const readText = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));
  const readRecord = Effect.fn("Artifacts.readRecord")(function* (dir: string) {
    const text = yield* readText(path.join(dir, FALLBACK_RECORD));
    if (text === null) return null;
    return parseRecord(text);
  });
  const createExclusive = Effect.fn("Artifacts.createExclusive")(
    (target: string, content: string) =>
      fs.writeFileString(target, content, { flag: "wx" }).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason._tag === "AlreadyExists",
          () => Effect.succeed(false),
        ),
      ),
  );
  const restoreOriginal = Effect.fn("Artifacts.restoreOriginal")(function* (
    target: string,
    aside: string,
  ) {
    const moved = yield* fs.readFileString(aside);
    if (yield* createExclusive(target, moved)) yield* fs.remove(aside, { force: true });
  });
  const replaceOwned = Effect.fn("Artifacts.replaceOwned")(function* (
    target: string,
    ownedHash: string,
    content: string,
    restore: Restore,
  ) {
    const aside = `${target}.${NodeCrypto.randomUUID()}.aside`;
    const renamed = yield* fs.rename(target, aside).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!renamed) return yield* restore(createExclusive(target, content));
    const written = yield* restore(
      Effect.gen(function* () {
        const moved = (yield* readText(aside)) ?? "";
        if (hash(moved) !== ownedHash) {
          yield* createExclusive(target, moved);
          return false;
        }
        return yield* createExclusive(target, content);
      }),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? restoreOriginal(target, aside).pipe(Effect.ignore) : Effect.void,
      ),
    );
    yield* fs.remove(aside, { force: true });
    return written;
  });
  const writeRecord = Effect.fn("Artifacts.writeRecord")(function* (
    dir: string,
    record: FallbackRecord,
  ) {
    const recordPath = path.join(dir, FALLBACK_RECORD);
    const temporary = `${recordPath}.${NodeCrypto.randomUUID()}.tmp`;
    yield* fs.writeFileString(temporary, recordText(record));
    yield* fs.rename(temporary, recordPath);
  });
  const applyFallbackNow = Effect.fn("Artifacts.applyFallbackNow")(
    (dir: string, runId: string, draft: string | null, options: FallbackOptions) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const record = yield* restore(readRecord(dir));
          if (record?.runId === runId) return;
          const files: Record<string, string> = { ...record?.files };
          if (draft !== null) {
            const target = path.join(dir, DRAFT_FILE);
            const content = `${draft}\n`;
            const current = yield* restore(readText(target));
            const owned = files[DRAFT_FILE];
            if (options.beforeWrite) yield* restore(options.beforeWrite(DRAFT_FILE));
            const written =
              current === null
                ? yield* restore(createExclusive(target, content))
                : owned !== undefined && hash(current) === owned
                  ? yield* replaceOwned(target, owned, content, restore)
                  : false;
            if (written) files[DRAFT_FILE] = hash(content);
            else delete files[DRAFT_FILE];
          }
          yield* writeRecord(dir, { runId, files });
        }),
      ),
  );
  return Artifacts.of({
    threadContextDir: (itemsDir, itemId, threadId) =>
      path.join(itemsDir, itemId, threadId.replace(/[^A-Za-z0-9._-]/g, "_")),
    readArtifacts: Effect.fn("Artifacts.readArtifacts")((dir) =>
      readText(path.join(dir, DRAFT_FILE)).pipe(
        Effect.map((text) => ({ draft: meaningful(text) })),
      ),
    ),
    fallbackApplied: Effect.fn("Artifacts.fallbackApplied")((dir, runId) =>
      readRecord(dir).pipe(Effect.map((record) => record?.runId === runId)),
    ),
    applyFallback: Effect.fn("Artifacts.applyFallback")((dir, runId, draft, options = {}) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          let entry = folders.get(dir);
          if (entry === undefined) {
            entry = { lock: Semaphore.makeUnsafe(1), users: 0 };
            folders.set(dir, entry);
          } else options.onQueued?.();
          entry.users++;
          return entry;
        }),
        (entry) => entry.lock.withPermit(applyFallbackNow(dir, runId, draft, options)),
        (entry) =>
          Effect.sync(() => {
            if (--entry.users === 0) folders.delete(dir);
          }),
      ),
    ),
    recordSent: Effect.fn("Artifacts.recordSent")(function* (input) {
      const source: SentSource =
        input.draftAtSend === null
          ? "typed"
          : input.draftAtSend === input.text
            ? "draft"
            : "edited draft";
      const stamp = input.sentAt.replace(/[:.]/g, "-");
      const tag = hash(input.messageId).slice(0, 8);
      yield* fs.makeDirectory(input.itemDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(input.itemDir, `sent.${stamp}.${tag}.md`),
        [
          "---",
          sentMessageId(input.messageId),
          `sentAt: ${input.sentAt}`,
          `source: ${source}`,
          "---",
          "",
          ...(input.text.length > 0 ? [input.text] : []),
          ...(input.files ?? []).map((name) => `[file: ${name}]`),
          "",
        ].join("\n"),
        { flag: "wx" },
      );
      if (input.draftDir !== null && input.draftAtSend !== null) {
        const draftPath = path.join(input.draftDir, DRAFT_FILE);
        if (meaningful(yield* readText(draftPath)) === input.draftAtSend) {
          if (source === "edited draft")
            yield* fs.rename(draftPath, path.join(input.draftDir, `draft.${stamp}.md`));
          else yield* fs.remove(draftPath, { force: true });
        }
      }
      return source;
    }, Effect.uninterruptible),
    discardDraft: Effect.fn("Artifacts.discardDraft")(function* (dir, shown, at) {
      const draftPath = path.join(dir, DRAFT_FILE);
      if (meaningful(yield* readText(draftPath)) !== shown.trim()) return false;
      yield* fs.rename(draftPath, path.join(dir, `draft.${at.replace(/[:.]/g, "-")}.discarded.md`));
      return true;
    }, Effect.uninterruptible),
    readSent: Effect.fn("Artifacts.readSent")(function* (dir) {
      const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
      const records = yield* Effect.forEach(
        names.filter((name) => name.startsWith("sent.") && name.endsWith(".md")),
        (name) =>
          Effect.gen(function* () {
            const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(
              (yield* readText(path.join(dir, name))) ?? "",
            );
            if (match === null) return null;
            const fields = new Map(
              match[1]!.split("\n").map((line) => {
                const colon = line.indexOf(":");
                return [line.slice(0, colon), line.slice(colon + 1).trim()] as const;
              }),
            );
            const sentAt = fields.get("sentAt");
            const source = SOURCES.find((candidate) => candidate === fields.get("source"));
            if (sentAt === undefined || source === undefined) return null;
            return { sentAt, source, text: match[2]!.trimEnd() } satisfies SentRecord;
          }),
        { concurrency: "unbounded" },
      );
      return records
        .filter((record) => record !== null)
        .toSorted((left, right) => right.sentAt.localeCompare(left.sentAt));
    }),
  });
});

export const layer = Layer.effect(Artifacts, make);
