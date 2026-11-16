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

/** False when the server refused; the user has been told. */
export async function setItemRead(
  environmentId: EnvironmentId,
  item: InboxItem,
  read: boolean,
): Promise<boolean> {
  try {
    await forkRequest(environmentId, "/inbox/read", {
      method: "POST",
      body: {
        channelId: item.channelId,
        conversationId: item.conversationId,
        topicId: item.topicId,
        read,
        // What the user saw, not what has arrived since.
        lastMessageAt: item.lastMessageAt,
        ...(item.thread?.runCompletedAt ? { runCompletedAt: item.thread.runCompletedAt } : {}),
      },
    });
    return true;
  } catch (error) {
    fail("Could not update the item", error);
    return false;
  }
}

/** Reads everything up to the newest message or run end in `items`, the list the user saw. */
export async function markAllRead(
  environmentId: EnvironmentId,
  channelId: string,
  items: ReadonlyArray<InboxItem>,
): Promise<boolean> {
  const times = items.flatMap((item) => [
    Date.parse(item.lastMessageAt),
    Date.parse(item.thread?.runCompletedAt ?? ""),
  ]);
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
