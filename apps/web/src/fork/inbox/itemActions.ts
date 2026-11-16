import type { EnvironmentId } from "@t3tools/contracts";

import { toastManager } from "../../components/ui/toast";
import { forkRequest } from "../forkApiAccess";
import type { DelegationDetail, InboxConversation, InboxDelegation } from "../types";
import { messagesAsText } from "./inboxView";

export const delegationPath = (channelId: string, delegationId: string) =>
  `/inbox/delegation?${new URLSearchParams({ channelId, delegationId }).toString()}`;

function fail(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

/** False when the server refused; the user has been told. */
export async function setConversationRead(
  environmentId: EnvironmentId,
  conversation: InboxConversation,
  read: boolean,
): Promise<boolean> {
  try {
    await forkRequest(environmentId, "/inbox/read", {
      method: "POST",
      body: {
        channelId: conversation.channelId,
        conversationId: conversation.id,
        read,
        // What the user saw, not what has arrived since.
        ...(conversation.lastMessage ? { lastMessageAt: conversation.lastMessage.createdAt } : {}),
      },
    });
    return true;
  } catch (error) {
    fail("Could not update the conversation", error);
    return false;
  }
}

/** Marks the delegation's finished run as seen; false when there was none or the server refused. */
export async function markDelegationSeen(
  environmentId: EnvironmentId,
  delegation: InboxDelegation,
): Promise<boolean> {
  const runCompletedAt = delegation.thread?.runCompletedAt;
  if (!runCompletedAt) return false;
  try {
    await forkRequest(environmentId, "/inbox/seen", {
      method: "POST",
      body: { channelId: delegation.channelId, delegationId: delegation.id, runCompletedAt },
    });
    return true;
  } catch (error) {
    fail("Could not update the delegation", error);
    return false;
  }
}

/** Reads everything up to the newest message or run end the user saw in the lists. */
export async function markAllRead(
  environmentId: EnvironmentId,
  channelId: string,
  conversations: ReadonlyArray<InboxConversation>,
  delegations: ReadonlyArray<InboxDelegation>,
): Promise<boolean> {
  const times = [
    ...conversations.map((conversation) => Date.parse(conversation.lastMessage?.createdAt ?? "")),
    ...delegations.map((delegation) => Date.parse(delegation.thread?.runCompletedAt ?? "")),
  ];
  const newest = Math.max(...times.filter(Number.isFinite));
  if (!Number.isFinite(newest)) return true;
  try {
    await forkRequest(environmentId, "/inbox/read-all", {
      method: "POST",
      body: { channelId, before: new Date(newest).toISOString() },
    });
    return true;
  } catch (error) {
    fail("Could not mark everything read", error);
    return false;
  }
}

export async function copyDelegationContext(detail: DelegationDetail) {
  try {
    await navigator.clipboard.writeText(messagesAsText(detail.conversation.name, detail.messages));
    toastManager.add({ type: "success", title: "Copied the messages" });
  } catch (error) {
    fail("Could not copy the messages", error);
  }
}
