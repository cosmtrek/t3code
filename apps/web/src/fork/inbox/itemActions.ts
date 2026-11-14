import type { EnvironmentId } from "@t3tools/contracts";

import { toastManager } from "../../components/ui/toast";
import { forkRequest } from "../forkApiAccess";
import type { InboxItem, TopicDetail } from "../types";
import { topicAsText } from "./inboxView";

const topicQuery = (item: InboxItem) =>
  new URLSearchParams({
    channelId: item.channelId,
    conversationId: item.conversationId,
    topicId: item.topicId,
  }).toString();

export const topicPath = (item: InboxItem) => `/inbox/topic?${topicQuery(item)}`;

function fail(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

export async function markItem(
  environmentId: EnvironmentId,
  item: InboxItem,
  state: "done" | "ignored" | null,
) {
  try {
    await forkRequest(environmentId, "/inbox/mark", {
      method: "POST",
      body: {
        channelId: item.channelId,
        conversationId: item.conversationId,
        topicId: item.topicId,
        state,
      },
    });
  } catch (error) {
    fail("Could not update the item", error);
  }
}

export async function copyItemContext(environmentId: EnvironmentId, item: InboxItem) {
  try {
    const detail = await forkRequest<TopicDetail>(environmentId, topicPath(item));
    await navigator.clipboard.writeText(topicAsText(item.conversationName, detail.messages));
    toastManager.add({ type: "success", title: "Copied the topic" });
  } catch (error) {
    fail("Could not copy the topic", error);
  }
}

export async function openItemInApp(environmentId: EnvironmentId, item: InboxItem) {
  // Opened before the request so popup blockers see the click.
  const opened = window.open("", "_blank");
  if (opened) opened.opener = null;
  try {
    const detail = await forkRequest<TopicDetail>(environmentId, topicPath(item));
    const message =
      detail.messages.find((candidate) => candidate.id === item.rootMessageId) ??
      detail.messages[0];
    if (!message?.openUrl) throw new Error("The adapter gave no link for this topic.");
    if (opened) opened.location.href = message.openUrl;
    else window.open(message.openUrl, "_blank", "noopener,noreferrer");
  } catch (error) {
    opened?.close();
    fail("Could not open the topic", error);
  }
}
