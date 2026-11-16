import type {
  ConversationKind,
  InboxChannelSummary,
  InboxItem,
  InboxMessage,
  TopicDetail,
} from "../types";
import { formatSince, formatSpan } from "../presentation";

export type InboxView = "unread" | "waiting" | "all";
export type InboxFilter = "all" | "dm" | "groups";

export const INBOX_VIEWS: ReadonlyArray<{ readonly id: InboxView; readonly label: string }> = [
  { id: "unread", label: "Unread" },
  { id: "waiting", label: "Waiting" },
  { id: "all", label: "All" },
];

export const INBOX_FILTERS: ReadonlyArray<{ readonly id: InboxFilter; readonly label: string }> = [
  { id: "all", label: "All conversations" },
  { id: "dm", label: "DMs" },
  { id: "groups", label: "Groups" },
];

const EMPTY_VIEW_TITLES: Readonly<Record<InboxView, string>> = {
  unread: "Nothing unread",
  waiting: "Nothing waiting",
  all: "No topics",
};

const FILTER_NOUNS: Readonly<Record<Exclude<InboxFilter, "all">, string>> = {
  dm: "DMs",
  groups: "group topics",
};

/** "Nothing unread", or "No unread DMs" when a filter is what empties the list. */
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

export interface ConversationRow {
  readonly message: InboxMessage;
  /** The message's topic as the inbox lists it; null when the inbox does not list that topic. */
  readonly item: InboxItem | null;
  /** The row that carries the topic's state, actions, and selection. */
  readonly anchor: boolean;
  /** The message this one answers, in a group that shows replies inline. */
  readonly quote: string | null;
}

const QUOTE_CHARS = 40;

/** `Sam: Who owns the retry…`, cut at 40 characters. */
export function quoteOf(author: string | null, text: string): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  const head =
    chars.length > QUOTE_CHARS ? `${chars.slice(0, QUOTE_CHARS).join("")}…` : chars.join("");
  return author === null ? head : `${nameOrUnknown(author)}: ${head}`;
}

/**
 * A conversation as its chat app shows it. DMs and plain groups show every message, a reply
 * quoting what it answers; a topic group shows each topic once, by its root. A topic whose root
 * is older than what was read stands on its earliest message read.
 */
export function conversationRows(
  messages: ReadonlyArray<InboxMessage>,
  items: ReadonlyArray<InboxItem>,
  kind: ConversationKind,
): ReadonlyArray<ConversationRow> {
  const itemsByTopic = new Map(items.map((item) => [item.topicId, item] as const));
  const byId = new Map(messages.map((message) => [message.id, message] as const));
  const anchored = new Set<string>();
  const rows: ConversationRow[] = [];
  for (const message of messages) {
    const item = itemsByTopic.get(message.topicId) ?? null;
    const anchor = !anchored.has(message.topicId);
    anchored.add(message.topicId);
    if (kind === "topic_group" && !anchor) continue;
    const root = item === null ? undefined : byId.get(item.rootMessageId);
    const quote =
      kind === "group" && item !== null && message.id !== item.rootMessageId
        ? root
          ? quoteOf(root.author.name, root.text || (root.richSummary ?? ""))
          : quoteOf(null, item.preview)
        : null;
    rows.push({ message, item, anchor, quote });
  }
  return rows;
}

/** What a reply in this topic answers, as the chat app will show it; none in a DM. */
export function replyTargetOf(
  detail: Pick<TopicDetail, "item" | "messages" | "conversation">,
): string | null {
  if (detail.conversation.kind === "dm") return null;
  const root = detail.messages.find((message) => message.id === detail.item.rootMessageId);
  return root ? quoteOf(root.author.name, root.text || (root.richSummary ?? "")) : null;
}

export interface ConversationPage {
  readonly messages: ReadonlyArray<InboxMessage>;
  readonly nextCursor: string | null;
}

/** Pages loaded above the newest one; `joinId` is the newest page's oldest message then. */
export interface OlderPages extends ConversationPage {
  readonly joinId: string;
}

/**
 * The newest page, read again on every change, below the older pages the reader loaded. Once
 * the newest page no longer holds the message the older ones were loaded above, more arrived
 * than a page holds: the older ones are dropped rather than shown across a gap.
 */
export function mergeConversationPages(
  newest: ConversationPage,
  older: OlderPages | null,
): ConversationPage & { readonly older: OlderPages | null } {
  if (older === null || !newest.messages.some((message) => message.id === older.joinId)) {
    return { ...newest, older: null };
  }
  const seen = new Set(newest.messages.map((message) => message.id));
  return {
    messages: [...older.messages.filter((message) => !seen.has(message.id)), ...newest.messages],
    nextCursor: older.nextCursor,
    older,
  };
}

/**
 * Whether the item belongs in the list. The selected item stays in Unread once opened, so
 * reading it does not pull it out from under the pointer.
 */
export function inView(
  view: InboxView,
  filter: InboxFilter,
  item: InboxItem,
  selectedId: string | null = null,
): boolean {
  const kindMatches =
    filter === "all" ||
    (filter === "dm" ? item.conversationKind === "dm" : item.conversationKind !== "dm");
  if (!kindMatches) return false;
  switch (view) {
    case "unread":
      return item.unread || item.id === selectedId;
    case "waiting":
      return item.awaitingReply;
    case "all":
      return true;
  }
}

const WAITING_HIGHLIGHT_MS = 24 * 3_600_000;

/** `useNowMinute` gives UTC "YYYY-MM-DDTHH:mm" with no zone, which Date.parse reads as local. */
export const minuteToMs = (minute: string) => Date.parse(`${minute}:00Z`);

/** Worked out here, not sent: a time-free list answers an unchanged read with a 304. */
const waitMsOf = (item: Pick<InboxItem, "lastMessageAt">, now: number) =>
  Math.max(0, now - Date.parse(item.lastMessageAt)) || 0;

/** A topic I answered that has waited on them for over a day. */
export const isOverdue = (item: Pick<InboxItem, "awaitingReply" | "lastMessageAt">, now: number) =>
  item.awaitingReply && waitMsOf(item, now) > WAITING_HIGHLIGHT_MS;

export function waitLabel(
  item: Pick<InboxItem, "awaitingReply" | "lastMessageAt">,
  now: number,
): string {
  const span = formatSpan(waitMsOf(item, now));
  if (item.awaitingReply) return span === "now" ? "just sent" : `sent ${span} ago`;
  return span;
}

/** Adapters may send an empty name. */
export const nameOrUnknown = (name: string) => (name.trim().length > 0 ? name.trim() : "Unknown");

/** "1 reply · Sam Okafor"; a waiting topic's last author is me, which its wait label says. */
export function itemMeta(
  item: Pick<InboxItem, "awaitingReply" | "replyCount" | "lastAuthor">,
): string | null {
  const parts: string[] = [];
  if (item.replyCount > 0) {
    parts.push(`${item.replyCount} ${item.replyCount === 1 ? "reply" : "replies"}`);
  }
  const author = item.lastAuthor.isSelf ? "You" : item.lastAuthor.name.trim();
  if (!item.awaitingReply && author.length > 0) parts.push(author);
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
