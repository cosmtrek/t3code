import type { EnvironmentId } from "@t3tools/contracts";

import { followUpNeedsYou, needsYou } from "../inbox/inboxView";
import type { InboxChannelSummary, InboxConversation, InboxDelegation } from "../types";

/** How many conversations the sidebar's Inbox group lists before "N more". */
export const SIDEBAR_INBOX_ROWS = 3;

export interface AttentionInbox {
  readonly environmentId: EnvironmentId;
  readonly channels: ReadonlyArray<Pick<InboxChannelSummary, "id" | "attention">>;
}

export interface AttentionItem {
  readonly environmentId: EnvironmentId;
  readonly channelId: string;
  readonly conversation: InboxConversation;
  /** The follow-up waiting on the user, when that is why it is listed. */
  readonly followUp: InboxDelegation | undefined;
}

/**
 * Every conversation that needs the user, by the inbox's own rule, most urgent first: a
 * follow-up waiting on them (work they started), then unread DMs, then mentions; newest first
 * within each. `blocked` holds each environment's threads that wait on the user.
 */
export function attentionItems(
  inboxes: ReadonlyArray<AttentionInbox>,
  blocked: ReadonlyMap<EnvironmentId, ReadonlySet<string>>,
): ReadonlyArray<AttentionItem> {
  const ranked: Array<{ readonly item: AttentionItem; readonly rank: number }> = [];
  for (const inbox of inboxes) {
    const blockedHere = blocked.get(inbox.environmentId) ?? new Set<string>();
    for (const channel of inbox.channels) {
      if (channel.attention === null) continue;
      const followUps = new Map<string, InboxDelegation[]>();
      for (const delegation of channel.attention.delegations) {
        const list = followUps.get(delegation.conversationId) ?? [];
        list.push(delegation);
        followUps.set(delegation.conversationId, list);
      }
      for (const conversation of channel.attention.conversations) {
        const open = followUps.get(conversation.id) ?? [];
        if (!needsYou(conversation, open, blockedHere)) continue;
        const followUp = open.find((delegation) => followUpNeedsYou(delegation, blockedHere));
        ranked.push({
          item: {
            environmentId: inbox.environmentId,
            channelId: channel.id,
            conversation,
            followUp,
          },
          rank: followUp ? 0 : conversation.kind === "dm" && conversation.unread ? 1 : 2,
        });
      }
    }
  }
  return ranked
    .toSorted(
      (left, right) =>
        left.rank - right.rank ||
        right.item.conversation.lastActivityAt.localeCompare(left.item.conversation.lastActivityAt),
    )
    .map(({ item }) => item);
}
