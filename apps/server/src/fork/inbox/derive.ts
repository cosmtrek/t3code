// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is effectful; item ids stay a plain function.
import * as NodeCrypto from "node:crypto";

import type { Conversation, Topic } from "../channels/protocol.ts";
import type { Mark, MarkState, TopicKey } from "./store.ts";

export type ItemState =
  | "needs_reply"
  | "drafted"
  | "investigating"
  | "waiting"
  | "open"
  | MarkState;

export type ItemCategory = "direct" | "participated" | "followed" | "other";

export const PENDING_STATES: ReadonlySet<ItemState> = new Set([
  "needs_reply",
  "drafted",
  "investigating",
]);

const WAITING_HIGHLIGHT_MS = 24 * 3_600_000;

const CATEGORY_WEIGHT: Readonly<Record<ItemCategory, number>> = {
  direct: 3,
  participated: 2,
  followed: 1,
  other: 0.5,
};

const STATE_RANK: Readonly<Record<ItemState, number>> = {
  needs_reply: 0,
  drafted: 0,
  investigating: 0,
  open: 1,
  waiting: 2,
  done: 3,
  ignored: 3,
};

/** Stable across restarts and adapters, short enough for a directory name. */
export function itemIdFor(key: TopicKey): string {
  return NodeCrypto.createHash("sha256")
    .update(`${key.channelId}\0${key.conversationId}\0${key.topicId}`)
    .digest("hex")
    .slice(0, 24);
}

export interface TopicFacts {
  readonly conversation: Pick<Conversation, "kind" | "relevant" | "muted">;
  readonly topic: Pick<Topic, "lastMessageAt" | "lastAuthor" | "participatedBySelf">;
  /** A message after my last one mentions me. */
  readonly mentionsSelf: boolean;
  readonly mark: Pick<Mark, "state" | "watermarkMessageAt"> | null;
  readonly threadRunning: boolean;
  readonly hasDraft: boolean;
  readonly now: number;
}

export interface DerivedItem {
  readonly state: ItemState;
  readonly category: ItemCategory;
  /** The mark was overtaken by a newer message from someone else. */
  readonly reopened: boolean;
  readonly waitMs: number;
  readonly highlight: boolean;
  readonly score: number;
}

export function deriveItem(facts: TopicFacts): DerivedItem {
  const { topic, conversation } = facts;
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
  const reopened =
    facts.mark !== null &&
    !lastIsSelf &&
    Date.parse(topic.lastMessageAt) > Date.parse(facts.mark.watermarkMessageAt);
  const state: ItemState =
    facts.mark !== null && !reopened
      ? facts.mark.state
      : facts.hasDraft
        ? "drafted"
        : facts.threadRunning
          ? "investigating"
          : lastIsSelf
            ? "waiting"
            : category === "direct" || category === "participated"
              ? "needs_reply"
              : "open";
  const hours = waitMs / 3_600_000;
  const score =
    state === "waiting" ? hours : CATEGORY_WEIGHT[category] * (1 + Math.log2(1 + hours));
  return {
    state,
    category,
    reopened,
    waitMs,
    highlight: state === "waiting" && waitMs > WAITING_HIGHLIGHT_MS,
    score,
  };
}

export function compareItems(
  left: Pick<DerivedItem, "state" | "score">,
  right: Pick<DerivedItem, "state" | "score">,
): number {
  return STATE_RANK[left.state] - STATE_RANK[right.state] || right.score - left.score;
}
