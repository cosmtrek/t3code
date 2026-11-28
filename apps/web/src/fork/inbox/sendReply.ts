import type { EnvironmentId } from "@t3tools/contracts";

import { toastManager } from "../../components/ui/toast";
import { ForkApiError } from "@t3tools/fork-client/http";
import { forkRequest } from "../forkApiAccess";
import type { ConversationResponse, InboxConversation, Mention, SendResult } from "../types";
import { mentionablePeople, mentionsIn } from "./inboxView";

type ConversationRef = Pick<InboxConversation, "channelId" | "id">;

/** People who wrote in the conversation's newest page; null when it could not be read. */
export async function readMentionable(
  environmentId: EnvironmentId,
  conversation: ConversationRef,
): Promise<ReadonlyArray<Mention> | null> {
  const page = await forkRequest<ConversationResponse>(
    environmentId,
    `/inbox/conversation?${new URLSearchParams({
      channelId: conversation.channelId,
      conversationId: conversation.id,
    }).toString()}`,
  ).catch(() => null);
  return page === null ? null : mentionablePeople(page.messages);
}

export interface ReplyToSend {
  readonly conversation: ConversationRef;
  readonly text: string;
  readonly replyTo: { readonly messageId: string; readonly inThread: boolean | null } | null;
  /** The delegation whose draft this is, edited or not. */
  readonly delegationId: string | null;
  readonly markdown: boolean;
  /** Whom `@name` in the text may mention. */
  readonly people: ReadonlyArray<Mention>;
  readonly attachments: ReadonlyArray<{ readonly uploadId: string | null; readonly name: string }>;
}

/** Sends the reply and reports what only partly went out; resolves with the error to show. */
export async function sendReply(
  environmentId: EnvironmentId,
  reply: ReplyToSend,
): Promise<string | null> {
  const mentioned = reply.text.includes("@") ? mentionsIn(reply.text, reply.people) : [];
  const result = await forkRequest<SendResult>(environmentId, "/inbox/send", {
    method: "POST",
    body: {
      channelId: reply.conversation.channelId,
      conversationId: reply.conversation.id,
      ...(reply.replyTo ? { replyToId: reply.replyTo.messageId } : {}),
      ...(reply.replyTo?.inThread != null ? { inThread: reply.replyTo.inThread } : {}),
      ...(reply.delegationId !== null ? { delegationId: reply.delegationId } : {}),
      text: reply.text,
      ...(mentioned.length > 0 ? { mentions: mentioned } : {}),
      ...(reply.markdown ? { format: "markdown" } : {}),
      ...(reply.attachments.length > 0
        ? {
            attachments: reply.attachments.map(({ uploadId, name }) => ({ uploadId, name })),
          }
        : {}),
    },
  }).catch((cause: unknown) => ({
    failure:
      cause instanceof ForkApiError && cause.code === "delivery_unknown"
        ? "Delivery unknown: the adapter did not confirm the message. Check the chat before sending again."
        : cause instanceof Error
          ? cause.message
          : String(cause),
  }));
  if ("failure" in result) return result.failure;
  if (result.failedAttachments.length > 0) {
    toastManager.add({
      type: "warning",
      title: `Sent, but these files did not go out: ${result.failedAttachments.join(", ")}.`,
    });
  }
  if (result.unresolvedMentions.length > 0) {
    toastManager.add({
      type: "warning",
      title: `Sent, but not everyone was notified: ${result.unresolvedMentions.join(", ")}.`,
    });
  }
  if (result.archived === false) {
    toastManager.add({
      type: "warning",
      title: "Sent, but the copy in the delegation's folder could not be saved.",
    });
  }
  return null;
}
