// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is effectful; item ids stay a plain function.
import * as NodeCrypto from "node:crypto";

import type { Conversation, Message, Topic } from "../channels/protocol.ts";
import type { Read, TopicKey } from "./store.ts";

export type ItemCategory = "direct" | "participated" | "followed" | "other";

const WAITING_HIGHLIGHT_MS = 24 * 3_600_000;

/** Stable across restarts and adapters, short enough for a directory name. */
export function itemIdFor(key: TopicKey): string {
  return NodeCrypto.createHash("sha256")
    .update(`${key.channelId}\0${key.conversationId}\0${key.topicId}`)
    .digest("hex")
    .slice(0, 24);
}

export interface TopicFacts {
  readonly conversation: Pick<Conversation, "kind" | "relevant" | "muted">;
  readonly topic: Pick<Topic, "lastMessageAt" | "lastAuthor" | "participatedBySelf"> & {
    readonly selfReadThroughAt?: string | null | undefined;
  };
  /** A message after my last one mentions me. */
  readonly mentionsSelf: boolean;
  /** When someone else last wrote in the topic; null when nobody else has. */
  readonly lastOtherMessageAt: string | null;
  readonly read: Pick<Read, "readAt" | "agentSeenAt" | "pinnedUnread"> | null;
  /** The channel-wide mark: anything before it, message or agent result, counts as seen. */
  readonly readAllBefore: string;
  /** When the current thread's last run worth a look finished; null while none has. */
  readonly runCompletedAt: string | null;
  readonly now: number;
}

export interface DerivedItem {
  readonly category: ItemCategory;
  readonly unread: boolean;
  /** The thread finished a run after the user last looked. */
  readonly agentUnseen: boolean;
  /** I wrote last: the topic waits on the others. */
  readonly awaitingReply: boolean;
  readonly waitMs: number;
  readonly highlight: boolean;
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

export function deriveItem(facts: TopicFacts): DerivedItem {
  const { topic, conversation, read } = facts;
  const lastIsSelf = topic.lastAuthor.isSelf;
  const lastAt = Date.parse(topic.lastMessageAt);
  const waitMs = Number.isFinite(lastAt) ? Math.max(0, facts.now - lastAt) : 0;
  const direct = conversation.kind === "dm" || facts.mentionsSelf;
  const category: ItemCategory = direct
    ? "direct"
    : topic.participatedBySelf
      ? "participated"
      : conversation.relevant && !conversation.muted
        ? "followed"
        : "other";
  const messageUnread =
    !lastIsSelf &&
    after(facts.lastOtherMessageAt, read?.readAt, topic.selfReadThroughAt, facts.readAllBefore);
  const agentUnseen = after(facts.runCompletedAt, read?.agentSeenAt, facts.readAllBefore);
  return {
    category,
    unread: (read?.pinnedUnread ?? false) || messageUnread || agentUnseen,
    agentUnseen,
    awaitingReply: lastIsSelf,
    waitMs,
    highlight: lastIsSelf && waitMs > WAITING_HIGHLIGHT_MS,
  };
}

/** What the sidebar badge counts: agent results, and unread topics I am part of. */
export function countsTowardBadge(
  item: Pick<DerivedItem, "unread" | "agentUnseen" | "category">,
): boolean {
  return (
    item.agentUnseen ||
    (item.unread && (item.category === "direct" || item.category === "participated"))
  );
}

/** Newest first; each view already picks its items. */
export function compareItems(
  left: { readonly lastMessageAt: string; readonly id: string },
  right: { readonly lastMessageAt: string; readonly id: string },
): number {
  return (
    Date.parse(right.lastMessageAt) - Date.parse(left.lastMessageAt) ||
    left.id.localeCompare(right.id)
  );
}

/** Oldest first by time; adapters may page in any order. */
export function sortMessages(messages: ReadonlyArray<Message>): ReadonlyArray<Message> {
  return messages.toSorted(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}
