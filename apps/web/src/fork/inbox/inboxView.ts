import type { InboxChannelSummary, InboxItem, InboxMessage, ItemState } from "../types";
import { formatSpan } from "../presentation";

export type InboxView = "pending" | "waiting" | "all" | "dm" | "groups";

export const INBOX_VIEWS: ReadonlyArray<{ readonly id: InboxView; readonly label: string }> = [
  { id: "pending", label: "Pending" },
  { id: "waiting", label: "Waiting" },
  { id: "all", label: "All" },
  { id: "dm", label: "DMs" },
  { id: "groups", label: "Groups" },
];

const PENDING: ReadonlySet<ItemState> = new Set(["needs_reply", "drafted", "investigating"]);

export function inView(view: InboxView, item: InboxItem): boolean {
  switch (view) {
    case "pending":
      return PENDING.has(item.state);
    case "waiting":
      return item.state === "waiting";
    case "all":
      return true;
    case "dm":
      return item.conversationKind === "dm" && item.state !== "ignored";
    case "groups":
      return item.conversationKind !== "dm" && item.state !== "ignored";
  }
}

export const STATE_LABELS: Readonly<Record<ItemState, string>> = {
  needs_reply: "Needs reply",
  drafted: "Draft ready",
  investigating: "Investigating",
  waiting: "Waiting",
  open: "New",
  done: "Done",
  ignored: "Ignored",
};

export function waitLabel(item: Pick<InboxItem, "state" | "waitMs">): string {
  const span = formatSpan(item.waitMs);
  if (item.state === "waiting") return span === "now" ? "just sent" : `sent ${span} ago`;
  return span === "now" ? "now" : `${span}`;
}

export interface ChannelBanner {
  readonly tone: "info" | "warning" | "error";
  readonly text: string;
  readonly showSettingsLink: boolean;
}

/** The health strip above the list; null hides it (online). */
export function channelBanner(
  channel: Pick<InboxChannelSummary, "status" | "statusSince" | "lastSyncAt" | "error">,
  now = Date.now(),
): ChannelBanner | null {
  const since = formatSpan(now - Date.parse(channel.statusSince));
  switch (channel.status) {
    case "online":
      return null;
    case "unreachable":
      return {
        tone: "warning",
        text: `The adapter has been unreachable for ${since}. Showing what was last read; sending is off.`,
        showSettingsLink: false,
      };
    case "collector_stopped":
      return {
        tone: "warning",
        text: `The adapter's collector stopped ${since} ago. New messages are not arriving; you can still send.`,
        showSettingsLink: false,
      };
    case "needs_login":
      return {
        tone: "error",
        text: `Sign in through the adapter to send. ${channel.error ?? ""}`.trim(),
        showSettingsLink: false,
      };
    case "token_missing":
    case "unauthorized":
    case "incompatible":
    case "disabled":
      return {
        tone: "error",
        text: channel.error ?? "This channel cannot be read.",
        showSettingsLink: true,
      };
  }
}

/** The topic as plain text, for pasting into another tool. */
export function topicAsText(
  conversationName: string,
  messages: ReadonlyArray<InboxMessage>,
): string {
  const lines = [`# ${conversationName}`, ""];
  for (const message of messages) {
    lines.push(`${message.author.name} · ${message.createdAt}`);
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
