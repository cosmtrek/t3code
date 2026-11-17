import type {
  ConversationKind,
  InboxChannelSummary,
  InboxConversation,
  InboxDelegation,
  InboxMessage,
  Mention,
} from "../types";
import { formatSince, formatSpan } from "../presentation";

export type InboxView = "unread" | "all" | "agent";
export type InboxFilter = "all" | "dm" | "groups" | "topics";

export const INBOX_VIEWS: ReadonlyArray<{ readonly id: InboxView; readonly label: string }> = [
  { id: "agent", label: "Agent" },
  { id: "unread", label: "Unread" },
  { id: "all", label: "All" },
];

export const INBOX_FILTERS: ReadonlyArray<{ readonly id: InboxFilter; readonly label: string }> = [
  { id: "all", label: "All conversations" },
  { id: "dm", label: "DMs" },
  { id: "groups", label: "Groups" },
  { id: "topics", label: "Topic groups" },
];

const EMPTY_VIEW_TITLES: Readonly<Record<InboxView, string>> = {
  unread: "Nothing unread",
  all: "No conversations",
  agent: "No delegations",
};

const FILTER_NOUNS: Readonly<Record<Exclude<InboxFilter, "all">, string>> = {
  dm: "DMs",
  groups: "groups",
  topics: "topic groups",
};

/** "Nothing unread", or "No unread DMs" when a filter is what empties the list. */
export function emptyViewTitle(view: InboxView, filter: InboxFilter): string {
  if (filter === "all") return EMPTY_VIEW_TITLES[view];
  const noun = FILTER_NOUNS[filter];
  switch (view) {
    case "unread":
      return `No unread ${noun}`;
    case "all":
      return `No ${noun}`;
    case "agent":
      return `No delegations from ${noun}`;
  }
}

/** "3 items from the adapter could not be read." */
export function skippedNotice(skipped: number): string | null {
  if (skipped === 0) return null;
  return `${skipped} ${skipped === 1 ? "item" : "items"} from the adapter could not be read.`;
}

const FILTER_KINDS: Readonly<Record<Exclude<InboxFilter, "all">, ConversationKind>> = {
  dm: "dm",
  groups: "group",
  topics: "topic_group",
};

export const matchesFilter = (filter: InboxFilter, kind: ConversationKind | undefined) =>
  filter === "all" || kind === FILTER_KINDS[filter];

/** What a conversation's delegations show on its row. */
export interface AgentSignals {
  /** Delegations whose thread finished a run the user has not looked at. */
  readonly unseen: number;
  readonly drafts: number;
  /** Delegations with a thread still linked. */
  readonly live: number;
}

export function agentSignalsFor(delegations: ReadonlyArray<InboxDelegation>): AgentSignals {
  let unseen = 0;
  let drafts = 0;
  let live = 0;
  for (const delegation of delegations) {
    if (delegation.agentUnseen) unseen += 1;
    if (delegation.hasDraft) drafts += 1;
    if (delegation.thread !== null && delegation.thread.detachedAt === null) live += 1;
  }
  return { unseen, drafts, live };
}

export function agentSignalsByConversation(
  delegations: ReadonlyArray<InboxDelegation>,
): ReadonlyMap<string, AgentSignals> {
  const byConversation = new Map<string, InboxDelegation[]>();
  for (const delegation of delegations) {
    const group = byConversation.get(delegation.conversationId);
    if (group) group.push(delegation);
    else byConversation.set(delegation.conversationId, [delegation]);
  }
  return new Map(
    [...byConversation].map(([conversationId, group]) => [conversationId, agentSignalsFor(group)]),
  );
}

/**
 * Whether the conversation belongs in Unread or All. Unread is people's messages; agent results
 * live in the Agent view. The held one, opened from Unread, stays there once read, so reading it
 * does not pull it out from under the pointer.
 */
export function inView(
  view: Exclude<InboxView, "agent">,
  filter: InboxFilter,
  conversation: Pick<InboxConversation, "id" | "kind" | "unread" | "mentioned">,
  heldId: string | null = null,
): boolean {
  if (!matchesFilter(filter, conversation.kind)) return false;
  if (view === "all") return true;
  return conversation.unread || conversation.mentioned || conversation.id === heldId;
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
 * The message as a quote: who wrote it and how it starts. A forward's text is the forwarded
 * chat with its own speakers, so the rich summary names the message better.
 */
export const quoteOfMessage = (message: InboxMessage) =>
  quoteOf(message.author.name, message.richSummary || message.text);

export interface ConversationRow {
  readonly message: InboxMessage;
  /** What the message answers, as the chat app shows it above the message. */
  readonly quote: string | null;
  /** The delegations that start at this message. */
  readonly delegations: ReadonlyArray<InboxDelegation>;
  /** The replies the chat app keeps inside this message's thread, off the timeline. */
  readonly thread: ReadonlyArray<ConversationRow>;
}

/**
 * A conversation as its chat app shows it: the timeline, a reply quoting what it answers, and
 * under a message the replies kept inside its thread. The adapter names the answered message; one
 * older than what was loaded is quoted from that, and a thread reply whose root is not loaded
 * stays on the timeline.
 */
export function conversationRows(
  messages: ReadonlyArray<InboxMessage>,
  delegations: ReadonlyArray<InboxDelegation>,
): ReadonlyArray<ConversationRow> {
  const byId = new Map(messages.map((message) => [message.id, message] as const));
  const byAnchor = new Map<string, InboxDelegation[]>();
  for (const delegation of delegations) {
    const list = byAnchor.get(delegation.anchorMessageId) ?? [];
    list.push(delegation);
    byAnchor.set(delegation.anchorMessageId, list);
  }
  const timeline: ConversationRow[] = [];
  const threads = new Map<string, ConversationRow[]>();
  for (const message of messages) {
    const replyTo = message.replyTo ?? null;
    const loaded = replyTo === null ? undefined : byId.get(replyTo.id);
    const quote =
      replyTo === null
        ? null
        : loaded
          ? quoteOfMessage(loaded)
          : replyTo.preview !== null
            ? quoteOf(replyTo.authorName, replyTo.preview)
            : "An earlier message";
    const row = { message, quote, delegations: byAnchor.get(message.id) ?? [], thread: [] };
    const rootId = message.inThread === true ? (message.rootId ?? null) : null;
    if (rootId === null || !byId.has(rootId)) timeline.push(row);
    else threads.set(rootId, [...(threads.get(rootId) ?? []), row]);
  }
  return timeline.map((row) => ({ ...row, thread: threads.get(row.message.id) ?? [] }));
}

/** A topic group's topic: its post, or only its replies when the post is older than the pages read. */
export interface Topic {
  readonly id: string;
  readonly post: ConversationRow | null;
  /** The post as the replies quote it, for a topic whose post is not loaded. */
  readonly heading: string | null;
  readonly replies: ReadonlyArray<ConversationRow>;
}

const latestActivity = (topic: Topic) =>
  Math.max(
    ...(topic.post === null ? [] : [Date.parse(topic.post.message.createdAt)]),
    ...topic.replies.map((reply) => Date.parse(reply.message.createdAt)),
  );

/**
 * A topic group as its chat app lists it: one card per topic, the one with the newest activity
 * last. Replies whose post was not loaded still share one card.
 */
export function topicsOf(rows: ReadonlyArray<ConversationRow>): ReadonlyArray<Topic> {
  const topics: Topic[] = [];
  const orphans = new Map<string, ConversationRow[]>();
  for (const row of rows) {
    const rootId = row.message.inThread === true ? (row.message.rootId ?? null) : null;
    if (rootId === null) {
      topics.push({ id: row.message.id, post: row, heading: null, replies: row.thread });
    } else {
      orphans.set(rootId, [...(orphans.get(rootId) ?? []), row]);
    }
  }
  for (const [id, replies] of orphans) {
    const first = replies[0]!;
    const heading = first.message.replyTo?.id === id ? first.quote : null;
    topics.push({ id, post: null, heading, replies });
  }
  return topics.toSorted((left, right) => latestActivity(left) - latestActivity(right));
}

function attachmentLabel(message: InboxMessage): string {
  const file = message.attachments[0];
  if (file === undefined) return "";
  return file.kind === "image" ? "[Image]" : `[File] ${file.name}`;
}

/** A reply as one line under a folded topic: who wrote it and what, whatever its length. */
export function replyLine(message: InboxMessage): string {
  const body = message.richSummary || message.text.trim() || attachmentLabel(message);
  return `${nameOrUnknown(message.author.name)}: ${body.replace(/\s+/g, " ").trim()}`;
}

/**
 * Where a delegation of this message starts. A reply thread is delegated from its root, so every
 * message in it delegates the same thing; a range starts at the message itself.
 */
export const anchorOf = (message: InboxMessage, scope: "chain" | "range") =>
  scope === "chain" ? (message.rootId ?? message.id) : message.id;

/** A DM has no reply threads to speak of; a group's message usually starts or joins one. */
export const defaultScope = (kind: ConversationKind) => (kind === "dm" ? "range" : "chain");

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

/** `useNowMinute` gives UTC "YYYY-MM-DDTHH:mm" with no zone, which Date.parse reads as local. */
export const minuteToMs = (minute: string) => Date.parse(`${minute}:00Z`);

/** How long ago, worked out here so an unchanged list answers a read with a 304. */
export const agoLabel = (at: string, now: number) =>
  formatSpan(Math.max(0, now - Date.parse(at)) || 0);

/** Adapters may send an empty name. */
export const nameOrUnknown = (name: string) => (name.trim().length > 0 ? name.trim() : "Unknown");

/** The row's second line: the last message, with its author unless it is the DM's other person. */
export function lastMessageLine(conversation: Pick<InboxConversation, "kind" | "lastMessage">) {
  const last = conversation.lastMessage;
  if (last === null) return "";
  if (last.author.isSelf) return `You: ${last.preview}`;
  const author = last.author.name.trim();
  return conversation.kind === "dm" || author.length === 0
    ? last.preview
    : `${author}: ${last.preview}`;
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

// Without the adapter's mentions, a name runs to the next space or punctuation, as the chat app ends it.
const GUESSED_MENTION = /(?<![A-Za-z0-9_.+-])@[^\s@,，.。:：;；!！?？()（）[\]【】"“”'‘’]+/gu;

export interface TextPart {
  readonly text: string;
  /** Set on an `@name`: whether it names the signed-in account. */
  readonly mention: { readonly self: boolean } | null;
}

/** Splits text into plain runs and `@name` mentions, by the adapter's list when it sent one. */
export function mentionParts(
  text: string,
  mentions?: ReadonlyArray<{ readonly name: string; readonly isSelf: boolean }> | null,
): ReadonlyArray<TextPart> {
  const known = (mentions ?? []).filter((mention) => mention.name.length > 0);
  const self = new Set(
    known.filter((mention) => mention.isSelf).map((mention) => `@${mention.name}`),
  );
  const pattern =
    mentions == null
      ? GUESSED_MENTION
      : known.length === 0
        ? null
        : new RegExp(
            // Longest first, so `@Zhang Sanfeng` is not taken by `@Zhang San`.
            known
              .map((mention) => `@${mention.name}`)
              .toSorted((left, right) => right.length - left.length)
              .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
              .join("|"),
            "gu",
          );
  if (pattern === null) return [{ text, mention: null }];
  const parts: Array<TextPart> = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), mention: null });
    parts.push({ text: match[0], mention: { self: self.has(match[0]) } });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), mention: null });
  return parts;
}

/** Who a reply can mention: everyone else who wrote, except a name two people share. */
export function mentionablePeople(messages: ReadonlyArray<InboxMessage>): ReadonlyArray<Mention> {
  const names = new Map<string, string>();
  for (const { author } of messages) {
    if (!author.isSelf && author.name.trim().length > 0) names.set(author.id, author.name);
  }
  const people = [...names].map(([userId, name]) => ({ userId, name }));
  return people.filter(
    (person) => people.filter((other) => other.name === person.name).length === 1,
  );
}

/** Who the text mentions: at each `@`, the longest name that follows it. */
export function mentionsIn(text: string, people: ReadonlyArray<Mention>): ReadonlyArray<Mention> {
  const longestFirst = people.toSorted((left, right) => right.name.length - left.name.length);
  const found = new Map<string, Mention>();
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const person = longestFirst.find((candidate) => text.startsWith(candidate.name, at + 1));
    if (person) found.set(person.userId, person);
  }
  return [...found.values()];
}

const MENTION_QUERY_MAX = 30;
const MENTION_SUGGESTIONS = 5;

/** The names that complete the `@…` being typed at the caret, and where that `@` is. */
export function mentionSuggestions(
  text: string,
  caret: number,
  people: ReadonlyArray<Mention>,
): { readonly start: number; readonly people: ReadonlyArray<Mention> } | null {
  const start = text.lastIndexOf("@", caret - 1);
  if (start === -1) return null;
  const query = text.slice(start + 1, caret).toLowerCase();
  if (query.includes("\n") || query.length > MENTION_QUERY_MAX) return null;
  const matches = people.filter(
    ({ name }) => name.length > query.length && name.toLowerCase().startsWith(query),
  );
  return matches.length === 0 ? null : { start, people: matches.slice(0, MENTION_SUGGESTIONS) };
}

/** The messages as plain text, for pasting into another tool. */
export function messagesAsText(
  conversationName: string,
  messages: ReadonlyArray<InboxMessage>,
): string {
  const lines = [`# ${nameOrUnknown(conversationName)}`, ""];
  for (const message of messages) {
    lines.push(`${nameOrUnknown(message.author.name)} · ${message.createdAt}`);
    if (message.richSummary) lines.push(`[${message.richSummary}]`);
    if (message.text.trim()) lines.push(message.text.trim());
    for (const attachment of message.attachments)
      lines.push(`[${attachment.kind}: ${attachment.name}]`);
    lines.push("");
  }
  const openUrl = messages.find((message) => message.openUrl)?.openUrl;
  if (openUrl) lines.push(openUrl);
  return lines.join("\n").trim();
}

/** A link as its site and first path segment; the full address is in the tooltip. */
export function shortLink(link: string): string {
  try {
    const url = new URL(link);
    const [first, ...rest] = url.pathname.split("/").filter((part) => part.length > 0);
    const host = url.host.replace(/^www\./, "");
    if (first === undefined) return host;
    return rest.length > 0 || url.search.length > 0 ? `${host}/${first}/…` : `${host}/${first}`;
  } catch {
    return link;
  }
}

/** Preview line for a delegation under its conversation, dropping a redundant "Name: " prefix. */
export function delegationPreview(
  conversationName: string,
  preview: string | null,
  threadTitle: string | null,
): string {
  const raw = preview?.trim() || threadTitle?.trim() || "";
  if (raw.length === 0) return "Delegated messages";
  const prefix = `${nameOrUnknown(conversationName)}: `;
  if (raw.startsWith(prefix)) {
    const stripped = raw.slice(prefix.length).trim();
    if (stripped.length > 0) return stripped;
  }
  return raw;
}

/** Unique author labels in order of appearance, capped at `max` with a `+N` overflow count. */
export function authorsSummary(messages: ReadonlyArray<InboxMessage>, max = 3): string | null {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const message of messages) {
    const label = message.author.isSelf ? "You" : nameOrUnknown(message.author.name);
    if (!seen.has(label)) {
      seen.add(label);
      names.push(label);
    }
  }
  if (names.length === 0) return null;
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max}`;
}
