/**
 * The wake packet: everything one turn needs, so no turn depends on what an earlier one left in
 * the provider's context. Pure, so its shape and caps are tested without a server.
 */
import { describeSchedule } from "./routines.ts";
import type { Skill } from "./skills.ts";
import type {
  ChatMessage,
  Goal,
  Item,
  MemoryNote,
  OwnedThread,
  Question,
  Routine,
} from "./store.ts";

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
  readonly goals: ReadonlyArray<Goal>;
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
}

const clip = (value: string, chars = MESSAGE_CHARS) =>
  value.length > chars ? `${value.slice(0, chars)}… (cut)` : value;

const speaker = (message: ChatMessage) =>
  message.role === "user" ? "the user" : message.role === "bot" ? "you" : "error";

const line = (message: ChatMessage) =>
  `- ${speaker(message)} (${message.createdAt}): ${clip(message.text)}`;

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
  const itemLines = (goalId: number | null) =>
    open.flatMap((item) =>
      item.goalId === goalId
        ? [
            `  #${item.id} [${item.status}] ${item.title}${item.note ? ` - ${item.note}` : ""}`,
            ...threadsOf(item.id),
          ]
        : [],
    );
  const goals = notebook.goals.filter((goal) => !goal.done);
  const loose = itemLines(null);
  const otherThreads = notebook.threads
    .filter((thread) => thread.itemId === null)
    .map(
      (thread) =>
        `  thread ${thread.threadId} "${thread.title ?? "untitled"}" (follow ${thread.follow})`,
    );
  return [
    "Goals and items:",
    ...(goals.length === 0 && loose.length === 0 ? ["  (none)"] : []),
    ...goals.flatMap((goal) => [` goal ${goal.id}: ${goal.title}`, ...itemLines(goal.id)]),
    ...(loose.length > 0 ? [" no goal:", ...loose] : []),
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

export function buildPacket(input: PacketInput): string {
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
  return [
    `You are ${input.name}, a bot working for the user in T3 Code. It is ${input.now.toString()}.`,
    role === ""
      ? "The user has not written your role yet. Work from the chat and your notebook, and ask when your job is unclear."
      : `Your role, in the user's words:\n${role}`,
    "",
    `How to act: only through \`${input.tool}\` from your shell (\`${input.tool} help\` lists commands).`,
    "- This thread is your workspace; the user does not read it. Your last message in a turn is",
    "  posted to the user. When nothing is worth telling them, end with exactly NO_REPLY.",
    "  Use `say` only to post something before the turn ends.",
    "- Your conversation here is reset often. Before you stop, write down what you must remember:",
    "  items for work in progress, routines for anything periodic, memory for lasting facts",
    "  (one fact per line; rewrite a note that changed, remove one that no longer holds).",
    `- Longer notes (findings, checklists, drafts) go in Markdown files in ${input.notesPath},`,
    "  read when needed; a memory line can point to one. Keep nothing in other memory tools.",
    "- Skills are how-tos you write for yourself: when you have worked out a procedure you will",
    `  repeat, write it as ${input.skillsPath}/<name>/SKILL.md, starting with frontmatter`,
    "  (`name:` and a one-line `description:` saying when it applies). Put one useful to every",
    `  bot in ${input.sharedSkillsPath}/<name>/ instead. Fix a skill when it turns out wrong.`,
    "  Every turn lists your skills, so they need no memory line. Read a skill's SKILL.md",
    "  before a task it applies to.",
    "- Do real work in threads you start with `thread start`, not here. They wake you when they",
    "  stop, so start one and end your turn; never wait on it.",
    "",
    renderNotebook(input.notebook),
    `Notes (${input.notesPath}):`,
    ...(input.notes.length === 0
      ? ["  (none)"]
      : input.notes.slice(0, NOTES_LISTED).map((note) => `  ${note.name} (${note.bytes} bytes)`)),
    "Skills:",
    ...(input.skills.length === 0
      ? ["  (none yet)"]
      : input.skills.map(
          (skill) =>
            `  ${skill.name}${skill.shared ? " (shared)" : ""}: ${skill.description || "(no description)"} - ${skill.path}`,
        )),
    ...(input.questions.length > 0
      ? [
          "Waiting for the user's answer:",
          ...input.questions.map(
            (question) =>
              `  question ${question.id}: ${clip(question.text.split("\n", 1)[0]!, 200)}`,
          ),
        ]
      : []),
    ...(stale.length > 0
      ? [
          "",
          `Stale (untouched for ${STALE_AFTER_DAYS} days; take a step, ask, or close it):`,
          ...stale.map((item) => `  #${item.id} ${item.title}`),
        ]
      : []),
    ...(recent.length > 0 ? ["", "Recent chat with the user:", ...recent.map(line)] : []),
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
}
