// @effect-diagnostics nodeBuiltinImport:off - Context folders are plain files an agent writes; the inbox reads and writes them outside Effect.
/**
 * Files a delegated thread reports back through. Each thread gets its own folder under the item,
 * `items/<itemId>/<thread>/`, so a newer delegation never shows, and an older thread never
 * overwrites, another thread's draft.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { DRAFT_FILE } from "./context.ts";

/** What the inbox wrote from tagged replies: the run, and a hash per file it still owns. */
const FALLBACK_RECORD = ".fallback.json";

function threadDirName(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function threadContextDir(itemsDir: string, itemId: string, threadId: string): string {
  return NodePath.join(itemsDir, itemId, threadDirName(threadId));
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await NodeFSP.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

const meaningful = (text: string | null) =>
  text !== null && text.trim().length > 0 ? text.trim() : null;

/** The draft as the inbox shows it; a blank file counts as none. */
export async function readArtifacts(dir: string): Promise<{ readonly draft: string | null }> {
  return { draft: meaningful(await readText(NodePath.join(dir, DRAFT_FILE))) };
}

interface FallbackRecord {
  readonly runId: string;
  readonly files: Readonly<Record<string, string>>;
}

const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

async function readRecord(dir: string): Promise<FallbackRecord | null> {
  const text = await readText(NodePath.join(dir, FALLBACK_RECORD));
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<FallbackRecord>;
    return typeof value.runId === "string" && typeof value.files === "object" && value.files
      ? { runId: value.runId, files: value.files }
      : null;
  } catch {
    return null;
  }
}

export async function fallbackApplied(dir: string, runId: string): Promise<boolean> {
  return (await readRecord(dir))?.runId === runId;
}

const isExists = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

/** Creates `target` only if nothing is there; false when the thread got there first. */
async function createExclusive(target: string, content: string): Promise<boolean> {
  try {
    await NodeFSP.writeFile(target, content, { flag: "wx" });
    return true;
  } catch (error) {
    if (isExists(error)) return false;
    throw error;
  }
}

/**
 * Replaces a file the inbox wrote earlier. It moves the file aside first, so a thread's write
 * that lands meanwhile is never overwritten: such a file either fails the ownership check or
 * makes the exclusive create fail.
 */
async function replaceOwned(target: string, ownedHash: string, content: string): Promise<boolean> {
  const aside = `${target}.${NodeCrypto.randomUUID()}.aside`;
  try {
    await NodeFSP.rename(target, aside);
  } catch {
    return createExclusive(target, content);
  }
  let removeAside = true;
  try {
    const moved = (await readText(aside)) ?? "";
    if (hash(moved) !== ownedHash) {
      await createExclusive(target, moved);
      return false;
    }
    return await createExclusive(target, content);
  } catch (error) {
    removeAside = false;
    try {
      const moved = await NodeFSP.readFile(aside, "utf8");
      removeAside = await createExclusive(target, moved);
    } catch {
      // Keep the recovery copy if restoring also fails.
    }
    throw error;
  } finally {
    if (removeAside) await NodeFSP.rm(aside, { force: true });
  }
}

/** Writes the record whole or not at all, so a reader never sees half of it. */
async function writeRecord(dir: string, record: FallbackRecord): Promise<void> {
  const recordPath = NodePath.join(dir, FALLBACK_RECORD);
  const temporary = `${recordPath}.${NodeCrypto.randomUUID()}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(record)}\n`);
  await NodeFSP.rename(temporary, recordPath);
}

/** Per folder, one fallback at a time: every read of the inbox may try to apply the same run. */
const folderQueues = new Map<string, Promise<void>>();

interface FallbackOptions {
  /** Tests land a thread's write, or another request, in the middle. */
  readonly beforeWrite?: (fileName: string) => Promise<void>;
  /** Called when this call has to wait for another one on the same folder. */
  readonly onQueued?: () => void;
}

/**
 * Writes the draft a run left in tags. A later run may replace what an earlier fallback wrote;
 * a draft the thread wrote itself always wins.
 */
export function applyFallback(
  dir: string,
  runId: string,
  draft: string | null,
  options: FallbackOptions = {},
): Promise<void> {
  const previous = folderQueues.get(dir);
  if (previous !== undefined) options.onQueued?.();
  const run = (previous ?? Promise.resolve()).then(() =>
    applyFallbackNow(dir, runId, draft, options),
  );
  const settled = run.catch(() => undefined);
  folderQueues.set(dir, settled);
  void settled.then(() => {
    if (folderQueues.get(dir) === settled) folderQueues.delete(dir);
  });
  return run;
}

async function applyFallbackNow(
  dir: string,
  runId: string,
  draft: string | null,
  options: FallbackOptions,
): Promise<void> {
  const record = await readRecord(dir);
  if (record?.runId === runId) return;
  const files: Record<string, string> = { ...record?.files };
  if (draft !== null) {
    const target = NodePath.join(dir, DRAFT_FILE);
    const content = `${draft}\n`;
    const current = await readText(target);
    const owned = files[DRAFT_FILE];
    await options.beforeWrite?.(DRAFT_FILE);
    const written =
      current === null
        ? await createExclusive(target, content)
        : owned !== undefined && hash(current) === owned
          ? await replaceOwned(target, owned, content)
          : false;
    if (written) files[DRAFT_FILE] = hash(content);
    else delete files[DRAFT_FILE];
  }
  await writeRecord(dir, { runId, files });
}

export type SentSource = "draft" | "edited draft" | "typed";

/**
 * Keeps what was sent, as sent, beside the item: the text, its message id, and whether it came
 * from the thread's draft. The draft it replaced is removed; an edited one is kept beside it.
 */
export async function recordSent(input: {
  readonly itemDir: string;
  /** The current thread's folder, or null when the delegation has no thread. */
  readonly draftDir: string | null;
  /** The draft as it was when the user pressed send. */
  readonly draftAtSend: string | null;
  readonly text: string;
  /** Names of the files sent with it. */
  readonly files?: ReadonlyArray<string>;
  readonly messageId: string;
  readonly sentAt: string;
}): Promise<SentSource> {
  const source: SentSource =
    input.draftAtSend === null
      ? "typed"
      : input.draftAtSend === input.text
        ? "draft"
        : "edited draft";
  const stamp = input.sentAt.replace(/[:.]/g, "-");
  const tag = hash(input.messageId).slice(0, 8);
  await NodeFSP.mkdir(input.itemDir, { recursive: true });
  // Two sends in one millisecond get two files; an existing record is never replaced.
  await NodeFSP.writeFile(
    NodePath.join(input.itemDir, `sent.${stamp}.${tag}.md`),
    [
      "---",
      `messageId: ${JSON.stringify(input.messageId)}`,
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
    const draftPath = NodePath.join(input.draftDir, DRAFT_FILE);
    // A draft the thread rewrote while this one was sending stays.
    if (meaningful(await readText(draftPath)) === input.draftAtSend) {
      if (source === "edited draft") {
        await NodeFSP.rename(draftPath, NodePath.join(input.draftDir, `draft.${stamp}.md`));
      } else {
        await NodeFSP.rm(draftPath, { force: true });
      }
    }
  }
  return source;
}

/**
 * Sets the draft aside as `draft.<stamp>.discarded.md`, only while it is still the one the user
 * saw; a draft the thread rewrote since stays.
 */
export async function discardDraft(dir: string, shown: string, at: string): Promise<boolean> {
  const draftPath = NodePath.join(dir, DRAFT_FILE);
  if (meaningful(await readText(draftPath)) !== shown.trim()) return false;
  await NodeFSP.rename(
    draftPath,
    NodePath.join(dir, `draft.${at.replace(/[:.]/g, "-")}.discarded.md`),
  );
  return true;
}

export interface SentRecord {
  readonly sentAt: string;
  readonly source: SentSource;
  readonly text: string;
}

const SOURCES: ReadonlyArray<SentSource> = ["draft", "edited draft", "typed"];

/** What `recordSent` kept for the item, newest first; a file it did not write is skipped. */
export async function readSent(itemDir: string): Promise<ReadonlyArray<SentRecord>> {
  let names: ReadonlyArray<string>;
  try {
    names = await NodeFSP.readdir(itemDir);
  } catch {
    return [];
  }
  const records = await Promise.all(
    names
      .filter((name) => name.startsWith("sent.") && name.endsWith(".md"))
      .map(async (name) => {
        const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(
          (await readText(NodePath.join(itemDir, name))) ?? "",
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
  );
  return records
    .filter((record) => record !== null)
    .toSorted((left, right) => right.sentAt.localeCompare(left.sentAt));
}
