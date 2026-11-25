// @effect-diagnostics nodeBuiltinImport:off - Skills are plain folders the bot writes with its shell.
/**
 * Skills bots write for themselves: a folder with a `SKILL.md` whose frontmatter names it and
 * says when it applies. A bot's own live in its workspace; shared ones, in `bots/skills/`, are
 * read by every bot in the environment. Packets name them by path, so any provider can use them.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly shared: boolean;
  /** The folder's name, which may differ from the frontmatter's. */
  readonly folder: string;
  readonly path: string;
}

const SKILLS_LISTED = 40;
const DESCRIPTION_CHARS = 300;

export const ownSkillsPath = (botsDir: string, botId: string) =>
  NodePath.join(botsDir, botId, "workspace", "skills");
export const sharedSkillsPath = (botsDir: string) => NodePath.join(botsDir, "skills");

/** `name` and `description` from a SKILL.md's frontmatter; a missing one is empty. */
function parseSkillFrontmatter(text: string): { name: string; description: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const field = (key: string) =>
    new RegExp(`^${key}:\\s*(.*)$`, "m")
      .exec(block)?.[1]
      ?.trim()
      .replace(/^(["'])(.*)\1$/, "$2") ?? "";
  return { name: field("name"), description: field("description") };
}

async function listIn(dir: string, shared: boolean): Promise<Skill[]> {
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const path = NodePath.join(dir, entry.name, "SKILL.md");
        const text = await NodeFSP.readFile(path, "utf8").catch(() => null);
        if (text === null) return null;
        const meta = parseSkillFrontmatter(text);
        return {
          name: meta.name || entry.name,
          description: meta.description.slice(0, DESCRIPTION_CHARS),
          shared,
          folder: entry.name,
          path,
        };
      }),
  );
  return skills.filter((skill) => skill !== null);
}

/** The bot's own skills, then the shared ones; an own skill hides a shared one of its name. */
export async function listSkills(botsDir: string, botId: string): Promise<ReadonlyArray<Skill>> {
  const own = await listIn(ownSkillsPath(botsDir, botId), false);
  const names = new Set(own.map((skill) => skill.name));
  const shared = (await listIn(sharedSkillsPath(botsDir), true)).filter(
    (skill) => !names.has(skill.name),
  );
  return [...own, ...shared]
    .toSorted(
      (left, right) =>
        Number(left.shared) - Number(right.shared) || left.name.localeCompare(right.name),
    )
    .slice(0, SKILLS_LISTED);
}
