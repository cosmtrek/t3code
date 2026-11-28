/**
 * The wake packet: everything a fresh provider session needs, so no turn depends on what an
 * earlier session left; within a session, only what changed. Pure, so its shape and caps are
 * tested without a server.
 */
import {
  collectAssistantCitations,
  expandAssistantCitationsForProvider,
} from "@t3tools/shared/assistantCitations";

import { describeSchedule } from "./routines.ts";
import type { Skill } from "./BotFiles.ts";
import type { ChatMessage, Item, MemoryNote, OwnedThread, Question, Routine } from "./store.ts";

/** Chat before the new messages; older chat lives in the work thread or is not needed. */
export const RECENT_CHAT_LIMIT = 10;
/** One chat message in the packet; a longer one is cut, its rest stays in the chat. */
const MESSAGE_CHARS = 2_000;
/** Events past this many are counted, not listed. */
const EVENT_LIMIT = 30;
const STALE_AFTER_DAYS = 7;
/** Note files named in the packet; the bot lists the folder for the rest. */
const NOTES_LISTED = 20;

export interface Notebook {
  readonly items: ReadonlyArray<Item>;
  readonly threads: ReadonlyArray<OwnedThread & { readonly title: string | null }>;
  readonly routines: ReadonlyArray<Routine>;
  readonly memory: ReadonlyArray<MemoryNote>;
}

export interface PacketInput {
  readonly name: string;
  readonly role: string;
  /** The tool command, ready to run: the CLI's path and this bot's id. */
  readonly tool: string;
  readonly notebook: Notebook;
  /** The bot's notes folder and what is in it, newest first. */
  readonly notesPath: string;
  readonly notes: ReadonlyArray<{ readonly name: string; readonly bytes: number }>;
  /** Where it writes its own skills and shared ones, and those it has. */
  readonly skillsPath: string;
  readonly sharedSkillsPath: string;
  readonly skills: ReadonlyArray<Pick<Skill, "name" | "description" | "path" | "shared">>;
  /** Its questions the user has not answered yet. */
  readonly questions: ReadonlyArray<Pick<Question, "id" | "text">>;
  /** Messages already answered, oldest first. */
  readonly recentChat: ReadonlyArray<ChatMessage>;
  /** User messages this turn answers, oldest first. */
  readonly newMessages: ReadonlyArray<ChatMessage>;
  /** What happened since the last turn, oldest first. */
  readonly events: ReadonlyArray<string>;
  /** Set on the first turn of a day: list items untouched for a week. */
  readonly now: Date;
  readonly firstTurnToday: boolean;
  /** Brief lines for the connectors it has on, such as chat channels. */
  readonly connectors: ReadonlyArray<string>;
  /** The flags of the model its threads run on unless it names another. */
  readonly threadModel: string;
}

const clip = (value: string, chars = MESSAGE_CHARS) =>
  value.length > chars ? `${value.slice(0, chars)}… (cut)` : value;

const speaker = (message: ChatMessage) =>
  message.role === "user" ? "the user" : message.role === "bot" ? "you" : "error";

/** Citations expand as they do for a thread turn; only the user's own words are cut. */
const line = (message: ChatMessage) => {
  const expanded = expandAssistantCitationsForProvider(message.text);
  const data = expanded.indexOf("\n\n<assistant_citations>");
  const words = data === -1 ? expanded : expanded.slice(0, data);
  const citations = data === -1 ? "" : expanded.slice(data);
  const pages = (message.renders ?? []).map((render) => ` [page shown: ${render.title}]`).join("");
  return `- ${speaker(message)} (${message.createdAt}):${pages} ${clip(words)}${citations}`;
};

/** A message as one line of plain text, its citations as their quoted words and comments. */
export function chatPreview(text: string): string {
  let plain = "";
  let cursor = 0;
  for (const { citation, start, end } of collectAssistantCitations(text)) {
    const comment = citation.comment ? ` (${citation.comment})` : "";
    plain += `${text.slice(cursor, start)} "${citation.text.trim()}"${comment} `;
    cursor = end;
  }
  return `${plain}${text.slice(cursor)}`.replace(/\s+/g, " ").trim();
}

/** The open notebook: what `t3bot notebook` prints and every packet carries. */
export function renderNotebook(notebook: Notebook): string {
  const open = notebook.items.filter((item) => item.status !== "done" && !item.setAside);
  const threadsOf = (itemId: number) =>
    notebook.threads
      .filter((thread) => thread.itemId === itemId)
      .map(
        (thread) =>
          `    thread ${thread.threadId} "${thread.title ?? "untitled"}" (follow ${thread.follow})`,
      );
  const itemLines = open.flatMap((item) => [
    `  #${item.id} [${item.status}] ${item.title}${item.note ? ` - ${item.note}` : ""}`,
    ...threadsOf(item.id),
  ]);
  const otherThreads = notebook.threads
    .filter((thread) => thread.itemId === null)
    .map(
      (thread) =>
        `  thread ${thread.threadId} "${thread.title ?? "untitled"}" (follow ${thread.follow})`,
    );
  return [
    "Items:",
    ...(itemLines.length === 0 ? ["  (none)"] : itemLines),
    ...(otherThreads.length > 0 ? ["Threads not tied to an item:", ...otherThreads] : []),
    "Routines:",
    ...(notebook.routines.length === 0
      ? ["  (none)"]
      : notebook.routines.map(
          (routine) =>
            `  ${routine.id}: ${describeSchedule(routine.schedule)} "${routine.title}" - ${clip(routine.prompt, 300)}`,
        )),
    "Memory:",
    ...(notebook.memory.length === 0
      ? ["  (none)"]
      : notebook.memory.map((note) => `  ${note.id}: ${note.text}`)),
  ].join("\n");
}

/**
 * The parts of a packet the provider session keeps once it has seen them: a turn in the same
 * session repeats only those that changed since.
 */
export type PacketSections = Readonly<
  Record<"brief" | "notebook" | "notes" | "skills" | "questions", string>
>;

export interface Packet {
  readonly text: string;
  readonly sections: PacketSections;
}

/**
 * The full packet when `seen` is null (a fresh provider session), otherwise only what is new to
 * a session that holds the earlier turns: changed sections, events, and the new messages.
 */
export function buildPacket(input: PacketInput, seen: PacketSections | null = null): Packet {
  const role = input.role.trim();
  const recent = input.recentChat
    .slice(-RECENT_CHAT_LIMIT)
    .filter((message) => message.role !== "error");
  const staleBefore = input.now.getTime() - STALE_AFTER_DAYS * 86_400_000;
  const stale = input.firstTurnToday
    ? input.notebook.items.filter(
        (item) =>
          item.status !== "done" && !item.setAside && Date.parse(item.updatedAt) < staleBefore,
      )
    : [];
  const events = input.events.slice(0, EVENT_LIMIT);
  const moreEvents = input.events.length - events.length;
  const sections: PacketSections = {
    brief: [
      role === ""
        ? "The user has not written your role yet. Work from the chat and your notebook, and ask when your job is unclear."
        : `Your role, in the user's words:\n${role}`,
      "",
      `How to act: only through \`${input.tool}\` from your shell (\`${input.tool} help\` lists commands).`,
      "- This thread is your workspace; the user does not read it. Your last message in a turn is",
      "  posted to the user. When nothing is worth telling them, end with exactly NO_REPLY.",
      "  Use `say` only to post something before the turn ends.",
      "- Your conversation here is reset often. Before you stop, write down what you must remember,",
      "  each in its one place:",
      "  - role: what the user wants from you - your job, scope, and rules for how to act",
      '    ("always...", "never...", "ask me before..."). The user owns it: when they give you',
      "    a rule, add it with `role add` (they approve it), never as memory. A rule says what",
      "    to do or not; steps for how to do a task go in a skill (below), even when the user gave",
      "    them and wants them followed every time.",
      "  - memory: facts you found about the world - paths, ids, who owns what, how things are set",
      "    up. One per line; rewrite one that changed, remove one that no longer holds.",
      "  - items for work in progress, routines for anything periodic.",
      `  - notes: longer findings, checklists, drafts, as Markdown files in ${input.notesPath},`,
      "    read when needed; a memory line can point to one. Keep nothing in other memory tools.",
      "- Skills are how-tos you write for yourself: when you have worked out a procedure you will",
      `  repeat, write it as ${input.skillsPath}/<name>/SKILL.md, starting with frontmatter`,
      "  (`name:` and a one-line `description:` saying when it applies). Put one useful to every",
      `  bot in ${input.sharedSkillsPath}/<name>/ instead. Fix a skill when it turns out wrong.`,
      "  Every turn lists your skills, so they need no memory line. Read a skill's SKILL.md",
      "  before a task it applies to.",
      "- Do real work in threads you start with `thread start`, not here. They wake you when they",
      "  stop, so start one and end your turn; never wait on it. They run on",
      `  \`${input.threadModel}\` unless you pass others.`,
      "- While a thread you follow `now` runs, the chat shows the user you are working and its",
      "  latest progress. So when you hand it what they asked, end with NO_REPLY rather than",
      "  saying you started; reply when it reports back.",
      "- A thread that stopped reports its last message to you. Trust what it found and pass it",
      "  on; check again only what looks wrong or is missing.",
      "- Before giving a thread more work, see how full its context is with `thread read`; when",
      "  `thread send` or `thread read` says so, send with `--fresh` so it does not compact.",
      ...input.connectors,
    ].join("\n"),
    notebook: renderNotebook(input.notebook),
    notes: [
      `Notes (${input.notesPath}):`,
      ...(input.notes.length === 0
        ? ["  (none)"]
        : input.notes.slice(0, NOTES_LISTED).map((note) => `  ${note.name} (${note.bytes} bytes)`)),
    ].join("\n"),
    skills: [
      "Skills:",
      ...(input.skills.length === 0
        ? ["  (none yet)"]
        : input.skills.map(
            (skill) =>
              `  ${skill.name}${skill.shared ? " (shared)" : ""}: ${skill.description || "(no description)"} - ${skill.path}`,
          )),
    ].join("\n"),
    questions:
      input.questions.length > 0
        ? [
            "Waiting for the user's answer:",
            ...input.questions.map(
              (question) =>
                `  question ${question.id}: ${clip(question.text.split("\n", 1)[0]!, 200)}`,
            ),
          ].join("\n")
        : seen !== null && seen.questions !== ""
          ? "Waiting for the user's answer: (nothing now)"
          : "",
  };
  const changed = (key: keyof PacketSections) =>
    sections[key] !== "" && (seen === null || sections[key] !== seen[key]) ? [sections[key]] : [];
  const fresh = seen === null;
  const text = [
    fresh
      ? `You are ${input.name}, a bot working for the user in T3 Code. It is ${input.now.toString()}.`
      : `It is ${input.now.toString()}. Your role and rules are as earlier in this conversation; only what changed since your last turn follows. Your last message still goes to the user, or NO_REPLY.`,
    ...(fresh
      ? [sections.brief, ""]
      : changed("brief").map((brief) => `Your brief changed:\n${brief}\n`)),
    ...changed("notebook"),
    ...changed("notes"),
    ...changed("skills"),
    ...changed("questions"),
    ...(stale.length > 0
      ? [
          "",
          `Stale (untouched for ${STALE_AFTER_DAYS} days; take a step, ask, or close it):`,
          ...stale.map((item) => `  #${item.id} ${item.title}`),
        ]
      : []),
    // A continuing session already holds the chat; only a fresh one needs it back.
    ...(fresh && recent.length > 0 ? ["", "Recent chat with the user:", ...recent.map(line)] : []),
    ...(events.length > 0
      ? [
          "",
          "What happened since your last turn:",
          ...events.map((event) => `- ${event}`),
          ...(moreEvents > 0 ? [`- and ${moreEvents} more`] : []),
        ]
      : []),
    ...(input.newMessages.length > 0
      ? ["", "New from the user:", ...input.newMessages.map(line)]
      : []),
  ].join("\n");
  return { text, sections };
}
