import type { InboxChannelSummary, InboxItem, InboxMessage, ItemState } from "../types";
import { formatSince, formatSpan } from "../presentation";

export type InboxView = "pending" | "waiting" | "all";
export type InboxFilter = "all" | "dm" | "groups";

export const INBOX_VIEWS: ReadonlyArray<{ readonly id: InboxView; readonly label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "waiting", label: "Waiting" },
  { id: "all", label: "All" },
];

export const INBOX_FILTERS: ReadonlyArray<{ readonly id: InboxFilter; readonly label: string }> = [
  { id: "all", label: "All conversations" },
  { id: "dm", label: "DMs" },
  { id: "groups", label: "Groups" },
];

const EMPTY_VIEW_TITLES: Readonly<Record<InboxView, string>> = {
  pending: "Nothing pending",
  waiting: "Nothing waiting",
  all: "No topics",
};

const FILTER_NOUNS: Readonly<Record<Exclude<InboxFilter, "all">, string>> = {
  dm: "DMs",
  groups: "group topics",
};

/** "Nothing pending", or "No pending DMs" when a filter is what empties the list. */
export function emptyViewTitle(view: InboxView, filter: InboxFilter): string {
  if (filter === "all") return EMPTY_VIEW_TITLES[view];
  const noun = FILTER_NOUNS[filter];
  return view === "all" ? `No ${noun}` : `No ${view} ${noun}`;
}

/** "3 items from the adapter could not be read." */
export function skippedNotice(skipped: number): string | null {
  if (skipped === 0) return null;
  return `${skipped} ${skipped === 1 ? "item" : "items"} from the adapter could not be read.`;
}

/** The selected topic's conversation, oldest first like a chat, so the latest sits at the bottom. */
export function conversationTopicsOf(
  items: ReadonlyArray<InboxItem>,
  selected: Pick<InboxItem, "conversationId"> | null,
): ReadonlyArray<InboxItem> {
  if (selected === null) return [];
  return items
    .filter((item) => item.conversationId === selected.conversationId)
    .toSorted(
      (left, right) =>
        Date.parse(left.lastMessageAt) - Date.parse(right.lastMessageAt) ||
        left.id.localeCompare(right.id),
    );
}

const PENDING: ReadonlySet<ItemState> = new Set(["needs_reply", "drafted", "investigating"]);

export function inView(view: InboxView, filter: InboxFilter, item: InboxItem): boolean {
  const kindMatches =
    filter === "all" ||
    (filter === "dm" ? item.conversationKind === "dm" : item.conversationKind !== "dm");
  if (!kindMatches) return false;
  switch (view) {
    case "pending":
      return PENDING.has(item.state);
    case "waiting":
      return item.state === "waiting";
    case "all":
      return true;
  }
}

export const STATE_LABELS: Readonly<Record<ItemState, string>> = {
  needs_reply: "Needs reply",
  drafted: "Draft ready",
  investigating: "Investigating",
  waiting: "Waiting",
  open: "New",
  done: "Done",
  ignored: "Ignored",
};

const WAITING_HIGHLIGHT_MS = 24 * 3_600_000;

/** `useNowMinute` gives UTC "YYYY-MM-DDTHH:mm" with no zone, which Date.parse reads as local. */
export const minuteToMs = (minute: string) => Date.parse(`${minute}:00Z`);

/** Worked out here, not sent: a time-free list answers an unchanged read with a 304. */
const waitMsOf = (item: Pick<InboxItem, "lastMessageAt">, now: number) =>
  Math.max(0, now - Date.parse(item.lastMessageAt)) || 0;

/** A topic I answered that has waited on them for over a day. */
export const isOverdue = (item: Pick<InboxItem, "state" | "lastMessageAt">, now: number) =>
  item.state === "waiting" && waitMsOf(item, now) > WAITING_HIGHLIGHT_MS;

export function waitLabel(item: Pick<InboxItem, "state" | "lastMessageAt">, now: number): string {
  const span = formatSpan(waitMsOf(item, now));
  if (item.state === "waiting") return span === "now" ? "just sent" : `sent ${span} ago`;
  return span;
}

/** Adapters may send an empty name. */
export const nameOrUnknown = (name: string) => (name.trim().length > 0 ? name.trim() : "Unknown");

/** "1 reply · Sam Okafor"; a waiting topic's last author is me, which its wait label says. */
export function itemMeta(
  item: Pick<InboxItem, "state" | "replyCount" | "lastAuthor">,
): string | null {
  const parts: string[] = [];
  if (item.replyCount > 0) {
    parts.push(`${item.replyCount} ${item.replyCount === 1 ? "reply" : "replies"}`);
  }
  const author = item.lastAuthor.isSelf ? "You" : item.lastAuthor.name.trim();
  if (item.state !== "waiting" && author.length > 0) parts.push(author);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface ChannelBanner {
  readonly tone: "warning" | "error";
  readonly text: string;
}

/** The health strip above the list; null hides it (online). */
export function channelBanner(
  channel: Pick<InboxChannelSummary, "status" | "statusSince" | "error">,
  now = Date.now(),
): ChannelBanner | null {
  const span = formatSpan(now - Date.parse(channel.statusSince));
  switch (channel.status) {
    case "online":
      return null;
    case "unreachable":
      return {
        tone: "warning",
        text: `Unreachable ${span === "now" ? "just now" : `for ${span}`} · showing last read · sending off`,
      };
    case "collector_stopped":
      return {
        tone: "warning",
        text: `Collector stopped ${formatSince(channel.statusSince, now)} · new messages paused`,
      };
    case "needs_login":
      return { tone: "error", text: "Signed out · sign in through the adapter to send" };
    case "token_missing":
    case "unauthorized":
    case "incompatible":
    case "disabled":
      return { tone: "error", text: channel.error ?? "This channel cannot be read" };
  }
}

/** A draft the reply box shows, and which thread wrote it. */
export interface DraftSource {
  readonly threadId: string | null;
  readonly text: string;
}

/**
 * The reply box text after the topic's draft changes. A draft the user has not touched follows
 * the thread: it is replaced by the new draft, or cleared when the draft is withdrawn or another
 * thread takes over. Anything the user typed stays.
 */
export function nextReplyText(
  text: string,
  shown: DraftSource | null,
  next: DraftSource | null,
): string {
  const untouched = text === (shown?.text ?? "");
  return untouched ? (next?.text ?? "") : text;
}

export const sameDraftSource = (left: DraftSource | null, right: DraftSource | null) =>
  left?.threadId === right?.threadId && left?.text === right?.text;

/** The topic as plain text, for pasting into another tool. */
export function topicAsText(
  conversationName: string,
  messages: ReadonlyArray<InboxMessage>,
): string {
  const lines = [`# ${nameOrUnknown(conversationName)}`, ""];
  for (const message of messages) {
    lines.push(`${nameOrUnknown(message.author.name)} · ${message.createdAt}`);
    if (message.text.trim()) lines.push(message.text.trim());
    if (message.richSummary) lines.push(`[${message.richSummary}]`);
    for (const attachment of message.attachments)
      lines.push(`[${attachment.kind}: ${attachment.name}]`);
    lines.push("");
  }
  const openUrl = messages.find((message) => message.openUrl)?.openUrl;
  if (openUrl) lines.push(openUrl);
  return lines.join("\n").trim();
}
