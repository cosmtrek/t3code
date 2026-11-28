// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is effectful; delegation ids stay a plain function.
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";

import type { Conversation, Message } from "../channels/protocol.ts";
import type { ConversationRead, Delegation } from "./store.ts";

/**
 * Stable across restarts and adapters, short enough for a directory name. A v1 topic id was its
 * first message's id, so a topic's old item id is the id of the delegation anchored there.
 */
export function delegationIdFor(key: {
  readonly channelId: string;
  readonly conversationId: string;
  readonly anchorMessageId: string;
}): string {
  return NodeCrypto.createHash("sha256")
    .update(`${key.channelId}\0${key.conversationId}\0${key.anchorMessageId}`)
    .digest("hex")
    .slice(0, 24);
}

const instant = (at: string | null | undefined) => (at ? Date.parse(at) : Number.NaN);

/** Whether `at` is after every mark; a mark that is missing or unparsable does not count. */
function after(at: string | null, ...marks: ReadonlyArray<string | null | undefined>): boolean {
  const time = instant(at);
  if (!Number.isFinite(time)) return false;
  return marks.every((mark) => {
    const markTime = instant(mark);
    return !Number.isFinite(markTime) || time > markTime;
  });
}

function latest(...marks: ReadonlyArray<string | null | undefined>): string | null {
  let found: string | null = null;
  for (const mark of marks) {
    if (Number.isFinite(instant(mark)) && (found === null || instant(mark) > instant(found))) {
      found = mark ?? null;
    }
  }
  return found;
}

export interface ConversationState {
  /** Someone else wrote after every read mark, or the user pinned it unread. */
  readonly unread: boolean;
  /** A mention I have not read or answered since. */
  readonly mentioned: boolean;
  /** The latest read mark, my own last message included; what came after it is new. */
  readonly readThroughAt: string | null;
  /** The chat app's badge; null when unknown or when T3 has read past where it counts from. */
  readonly unreadCount: number | null;
}

/**
 * Reads only go one way: reading in the chat app clears the conversation here, reading here
 * leaves the chat app as it was.
 */
export function deriveConversation(input: {
  readonly conversation: Pick<
    Conversation,
    "lastMessage" | "lastOtherMessageAt" | "lastSelfMessageAt" | "lastMentionAt"
  > & {
    readonly selfReadThroughAt?: string | null | undefined;
    readonly unreadCount?: number | null | undefined;
  };
  readonly read: Pick<ConversationRead, "readAt" | "pinnedUnread"> | null;
  /** The channel-wide mark: anything before it counts as seen. */
  readonly readAllBefore: string;
}): ConversationState {
  const { conversation, read } = input;
  const marks = [read?.readAt, conversation.selfReadThroughAt, input.readAllBefore];
  const lastIsSelf = conversation.lastMessage?.author.isSelf ?? false;
  // The badge counts from the chat app's own read point; reading further in T3 does not reach it.
  const chatReadAt = latest(conversation.selfReadThroughAt, conversation.lastSelfMessageAt);
  const t3ReadAt = chatReadAt === null ? read?.readAt : latest(read?.readAt, input.readAllBefore);
  const countHolds = t3ReadAt == null || !after(t3ReadAt, chatReadAt);
  return {
    unread:
      (read?.pinnedUnread ?? false) ||
      (!lastIsSelf && after(conversation.lastOtherMessageAt, ...marks)),
    mentioned: after(conversation.lastMentionAt, ...marks, conversation.lastSelfMessageAt),
    readThroughAt: latest(...marks, conversation.lastSelfMessageAt),
    unreadCount: countHolds ? (conversation.unreadCount ?? null) : null,
  };
}

/** The thread finished a run after the user last looked at the delegation. */
export function agentUnseen(input: {
  readonly delegation: Pick<Delegation, "agentSeenAt">;
  readonly runCompletedAt: string | null;
  readonly readAllBefore: string;
}): boolean {
  return after(input.runCompletedAt, input.delegation.agentSeenAt, input.readAllBefore);
}

/**
 * What the sidebar badge counts: unread DMs and groups that mention me. A followed group with
 * only new messages shows in Unread but is not counted. Agent results are counted apart.
 */
export function conversationCountsTowardBadge(
  kind: Conversation["kind"],
  state: Pick<ConversationState, "unread" | "mentioned">,
): boolean {
  return kind === "dm" ? state.unread : state.mentioned;
}

/** Newest first. */
export function compareConversations(
  left: { readonly lastActivityAt: string; readonly id: string },
  right: { readonly lastActivityAt: string; readonly id: string },
): number {
  return (
    Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) ||
    left.id.localeCompare(right.id)
  );
}

/** Oldest first by time; adapters may page in any order. */
export function sortMessages(messages: ReadonlyArray<Message>): ReadonlyArray<Message> {
  return messages.toSorted(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}

/** A v1 topic in a DM was a six-hour window from its first message. */
const LEGACY_DM_WINDOW_MS = 6 * 3_600_000;

/**
 * Whether the delegation reads a message and its replies. One made from a v1 topic stores no
 * scope: in a DM it was a window of time, elsewhere a message and its replies.
 */
export function scopeIsChain(
  delegation: Pick<Delegation, "scope">,
  kind: Conversation["kind"],
): boolean {
  return delegation.scope === "chain" || (delegation.scope === null && kind !== "dm");
}

/** The last time a range covers; null runs to the newest message. */
export function rangeUntil(
  delegation: Pick<Delegation, "scope" | "untilAt">,
  anchorAt: string | null,
): string | null {
  if (delegation.scope === "range") return delegation.untilAt;
  const anchor = instant(anchorAt);
  if (!Number.isFinite(anchor)) return null;
  return DateTime.formatIso(DateTime.makeUnsafe(anchor + LEGACY_DM_WINDOW_MS));
}

/**
 * The messages a range covers: from the anchor through `untilAt`, or to the end when null. Of
 * the replies kept inside a thread, only those of a thread the range holds, or the anchor's own.
 */
export function messagesInRange(
  messages: ReadonlyArray<Message>,
  anchorMessageId: string,
  untilAt: string | null,
): ReadonlyArray<Message> {
  const sorted = sortMessages(messages);
  const start = sorted.findIndex((message) => message.id === anchorMessageId);
  if (start === -1) return [];
  const until = instant(untilAt);
  const anchor = sorted[start]!;
  const inWindow = sorted
    .slice(start)
    .filter((message) => !Number.isFinite(until) || Date.parse(message.createdAt) <= until);
  const onTimeline = new Set(
    inWindow.filter((message) => message.inThread !== true).map((message) => message.id),
  );
  return inWindow.filter(
    (message) =>
      message.inThread !== true ||
      message.id === anchor.id ||
      (message.rootId != null &&
        (onTimeline.has(message.rootId) || message.rootId === anchor.rootId)),
  );
}
