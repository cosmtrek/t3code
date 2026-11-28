import type { ModelSelection, RuntimeMode } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";

/** Responses of `/api/fork/bots/*`, mirrored from apps/server/src/fork/bot. */
export interface BotSummary {
  readonly id: string;
  readonly name: string;
  readonly modelSelection: ModelSelection;
  readonly working: boolean;
  readonly paused: boolean;
  readonly lastMessage: Pick<BotChatMessage, "role" | "text" | "createdAt"> | null;
  /** Its posts the user has not seen. */
  readonly unread: number;
  /** Its questions waiting for the user. */
  readonly questions: number;
  /** Its own thread, which the sidebar leaves out: the bot's row stands for it. */
  readonly workThreadId: string | null;
}

export type BotPermission = "allow" | "ask";

/** One connector instance, as this bot may use it. */
export interface BotConnectorSettings {
  readonly enabled: boolean;
  /** Per write operation; one missing here asks. */
  readonly permissions: Readonly<Record<string, BotPermission>>;
  /** The kind's own settings; for chat: `signature`, `mentions`. */
  readonly config: Readonly<Record<string, unknown>>;
}

export interface BotSettings {
  readonly turnsPerDay: number;
  readonly maxThreads: number;
  readonly runtimeMode: RuntimeMode;
  /** What threads it starts run on unless it names another; null is its own model. */
  readonly threadModel: ModelSelection | null;
  /** By instance id; one missing here is off. */
  readonly connectors: Readonly<Record<string, BotConnectorSettings>>;
}

/** A connector instance of the environment, such as a chat channel, for a bot's settings. */
export interface BotConnectorInstance {
  /** Also its `t3bot` command. */
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly status: "ok" | "degraded" | "down";
  readonly reason: string | null;
  /** Its writes, each allow or ask per bot. */
  readonly operations: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  /** What its kind adds; for chat, the bot that wakes on the user's mentions there now. */
  readonly info: Readonly<Record<string, unknown>>;
}

/** An action the bot asked to take; approving runs exactly it. */
export interface BotQuestion {
  readonly id: number;
  /** What it would do, then a blank line and the details (prompt, message, role). */
  readonly text: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface BotChatMessage {
  readonly id: string;
  readonly role: "user" | "bot" | "error";
  readonly text: string;
  readonly createdAt: string;
  /** For a user message: the turn that took it; null while it waits for one. */
  readonly turnRunId: string | null;
  /** Pages its work thread showed with `html_render`, drawn above the text. */
  readonly renders?: ReadonlyArray<HtmlRenderReference>;
}

export interface BotActivity {
  readonly text: string;
  readonly threadId: string;
  /** A tool call's item as JSON; absent when the line is a message's. */
  readonly step?: unknown;
}

export interface BotDetail {
  readonly workspacePath: string;
  readonly bot: {
    readonly id: string;
    readonly name: string;
    readonly modelSelection: ModelSelection;
    readonly workThreadId: string | null;
    readonly paused: boolean;
    readonly settings: BotSettings;
    readonly lastTurnDay: string | null;
    readonly turnsToday: number;
  };
  readonly role: string;
  /** When it started on what it works on: its turn, then the threads it follows `now`. */
  readonly workingSince: string | null;
  /** The latest message or tool call of the thread working on it; null while idle. */
  readonly activity: BotActivity | null;
  /** Oldest first. */
  readonly chat: ReadonlyArray<BotChatMessage>;
  readonly notebook: BotNotebook;
  readonly questions: ReadonlyArray<BotQuestion>;
  /** The folder the bot keeps longer notes in, and its files, newest first. */
  readonly notesPath: string;
  readonly notes: ReadonlyArray<{
    readonly name: string;
    readonly bytes: number;
    readonly updatedAt: string;
  }>;
  /** Skills the bot wrote: its own first, then those every bot shares. */
  readonly skills: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly shared: boolean;
    readonly folder: string;
    readonly path: string;
  }>;
  /** The environment's connector instances, such as its chat channels. */
  readonly connectors: ReadonlyArray<BotConnectorInstance>;
}

export interface BotNotebook {
  readonly items: ReadonlyArray<{
    readonly id: number;
    readonly title: string;
    readonly status: "open" | "waiting" | "done";
    readonly note: string;
    readonly updatedAt: string;
    readonly setAside: boolean;
  }>;
  readonly threads: ReadonlyArray<{
    readonly threadId: string;
    readonly itemId: number | null;
    readonly follow: "now" | "attention" | "routine";
    readonly title: string | null;
    readonly createdAt: string;
    /** Its latest run's status, as the bot last saw it. */
    readonly status: string;
    /** The user typed in it; it is theirs until they hand it back. */
    readonly takenOver: boolean;
  }>;
  readonly routines: ReadonlyArray<{
    readonly id: number;
    readonly title: string;
    readonly prompt: string;
    readonly schedule:
      | { readonly type: "daily"; readonly time: string; readonly weekdays?: ReadonlyArray<number> }
      | { readonly type: "every"; readonly minutes: number };
    readonly nextDueAt: string | null;
  }>;
  readonly memory: ReadonlyArray<{ readonly id: number; readonly text: string }>;
}

/**
 * A bot row's one status, the most pressing: a question, its work thread waiting on the user,
 * unread posts, work under way, paused, or its age. `blocked` is the work thread's status only
 * when it waits on the user; each client names those statuses its own way.
 */
export type BotRowStatus<Blocked extends string> =
  | { readonly kind: "question" }
  | { readonly kind: "blocked"; readonly status: Blocked }
  | { readonly kind: "unread"; readonly count: number }
  | { readonly kind: "working" }
  | { readonly kind: "paused" }
  | { readonly kind: "age"; readonly at: string }
  | { readonly kind: "none" };

export function botRowStatus<Blocked extends string>(
  bot: BotSummary,
  blocked: Blocked | null,
): BotRowStatus<Blocked> {
  if (bot.questions > 0) return { kind: "question" };
  if (blocked !== null) return { kind: "blocked", status: blocked };
  if (bot.unread > 0) return { kind: "unread", count: bot.unread };
  if (bot.working) return { kind: "working" };
  if (bot.paused) return { kind: "paused" };
  return bot.lastMessage ? { kind: "age", at: bot.lastMessage.createdAt } : { kind: "none" };
}

/** What a collapsed Bots group shows for its hidden rows, most pressing first. */
export type BotAttention = "attention" | "failed" | "unread" | "working";

export const BOT_ATTENTION_ORDER: ReadonlyArray<BotAttention> = [
  "attention",
  "failed",
  "unread",
  "working",
];

export function botAttention(status: BotRowStatus<string>): BotAttention | null {
  switch (status.kind) {
    case "question":
      return "attention";
    case "blocked":
      return status.status === "failed" ? "failed" : "attention";
    case "unread":
      return "unread";
    case "working":
      return "working";
    default:
      return null;
  }
}

/** Each bot's own work thread, as `environmentId:threadId`; lists leave these out. */
export function botWorkThreadKeys(
  listings: ReadonlyArray<{
    readonly environmentId: string;
    readonly bots: ReadonlyArray<BotSummary>;
  }>,
): ReadonlyArray<string> {
  return listings.flatMap((listing) =>
    listing.bots.flatMap((bot) =>
      bot.workThreadId === null ? [] : [`${listing.environmentId}:${bot.workThreadId}`],
    ),
  );
}

/** Posts made together, such as a reply and the pages it showed, read as one. */
const SAME_POST_MS = 5_000;
const LONG_GAP_MS = 10 * 60_000;

/**
 * Whether the chat marks the time above `message`: when the bot posts again without the user
 * writing in between (a follow-up, a report, a routine), after a long gap, or on a new day.
 */
export function startsChatBreak(
  previous: Pick<BotChatMessage, "role" | "createdAt"> | undefined,
  message: Pick<BotChatMessage, "role" | "createdAt">,
): boolean {
  if (previous === undefined) return false;
  const before = new Date(previous.createdAt);
  const at = new Date(message.createdAt);
  const gap = at.getTime() - before.getTime();
  if (Number.isNaN(gap)) return false;
  if (gap >= LONG_GAP_MS || at.toDateString() !== before.toDateString()) return true;
  return previous.role !== "user" && message.role !== "user" && gap >= SAME_POST_MS;
}
