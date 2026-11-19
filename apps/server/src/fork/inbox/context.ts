// @effect-diagnostics-next-line nodeBuiltinImport:off -- media names are a plain hash.
import * as NodeCrypto from "node:crypto";

import type { Conversation, Message } from "../channels/protocol.ts";

export const CONCLUSION_FILE = "conclusion.md";
export const DRAFT_FILE = "draft.md";
export const CONTEXT_FILE = "context.md";
export const REQUEST_FILE = "request.json";
export const MEDIA_DIR = "media";

const replyFormat = (markdown: boolean) =>
  markdown ? "simple Markdown, no headings or tables" : "plain text";

function writeBackInstructions(contextDir: string, markdown: boolean): string {
  return [
    "## Reporting back",
    "",
    `- Keep your findings in \`${contextDir}/${CONCLUSION_FILE}\` (Markdown), current as they change.`,
    `- Write \`${contextDir}/${DRAFT_FILE}\` only when a message of mine asks for the reply to the chat, such as "reply that…", "tell them…", or "make it shorter". Write the whole reply, ready to send in the conversation's language, as ${replyFormat(markdown)}. Questions and other tasks leave it alone.`,
    "- If you cannot write files there, end your last message with `<conclusion>…</conclusion>` or `<draft>…</draft>` instead.",
  ].join("\n");
}

/** Replaces `{contextDir}`, `{note}`, and `{openUrl}`; other braces stay as they are. */
export function fillTemplate(
  template: string,
  values: { readonly contextDir: string; readonly note: string; readonly openUrl: string | null },
): string {
  const replacements: Record<string, string> = {
    contextDir: values.contextDir,
    note: values.note.trim().length > 0 ? values.note.trim() : "(none)",
    openUrl: values.openUrl ?? "(not available)",
  };
  return template.replace(/\{(contextDir|note|openUrl)\}/g, (_, key: string) => replacements[key]!);
}

/** Adapters may send an empty name; the thread and its title still need one. */
export const nameOrUnknown = (name: string) => (name.trim().length > 0 ? name.trim() : "Unknown");

const skippedLine = (skipped: number, where: string) =>
  `${skipped} ${skipped === 1 ? "message" : "messages"} in this conversation could not be read and ${skipped === 1 ? "is" : "are"} missing ${where}.`;

export function firstMessage(input: {
  readonly template: string;
  readonly contextDir: string;
  readonly note: string;
  readonly openUrl: string | null;
  readonly skippedMessages: number;
  readonly markdown: boolean;
}): string {
  const body = fillTemplate(input.template, input);
  const parts = [body.trim()];
  if (input.skippedMessages > 0) {
    parts.push(skippedLine(input.skippedMessages, `from ${CONTEXT_FILE}`));
  }
  if (input.openUrl !== null && !body.includes(input.openUrl)) {
    parts.push(`Open in app: ${input.openUrl}`);
  }
  if (!body.includes(CONCLUSION_FILE) || !body.includes(DRAFT_FILE)) {
    parts.push(writeBackInstructions(input.contextDir, input.markdown));
  }
  return parts.join("\n\n");
}

const TITLE_SUMMARY_CHARS = 48;

/** `Sender: summary`, the summary cut at a word or sentence end near 48 characters. */
export function threadTitle(senderName: string, preview: string): string {
  const chars = Array.from(preview.replace(/\s+/g, " ").trim());
  if (chars.length <= TITLE_SUMMARY_CHARS) return `${senderName}: ${chars.join("")}`;
  const head = chars.slice(0, TITLE_SUMMARY_CHARS + 1).join("");
  const sentenceEnd = Math.max(
    ...[". ", "! ", "? ", "。", "！", "？"].map((mark) => head.lastIndexOf(mark)),
  );
  if (sentenceEnd >= TITLE_SUMMARY_CHARS / 2) {
    return `${senderName}: ${head.slice(0, sentenceEnd + 1)}`;
  }
  const wordEnd = head.lastIndexOf(" ");
  // Text without spaces (CJK) is cut where it is.
  const summary =
    wordEnd >= TITLE_SUMMARY_CHARS / 2
      ? head.slice(0, wordEnd)
      : chars.slice(0, TITLE_SUMMARY_CHARS).join("");
  return `${senderName}: ${summary.trimEnd()}…`;
}

/** The last `<tag>…</tag>` in an agent reply, trimmed; null when it has none. */
function lastTagged(text: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let found: string | null = null;
  for (const match of text.matchAll(pattern)) found = match[1]!.trim();
  return found !== null && found.length > 0 ? found : null;
}

export function parseFallbackReply(text: string): {
  readonly conclusion: string | null;
  readonly draft: string | null;
} {
  return { conclusion: lastTagged(text, "conclusion"), draft: lastTagged(text, "draft") };
}

export interface ContextImage {
  readonly messageId: string;
  readonly key: string;
  readonly path: string | null;
}

export interface SenderHistoryEntry {
  readonly at: string;
  readonly conversationName: string;
  readonly preview: string;
  readonly state: string;
}

const KIND_LABEL: Readonly<Record<Conversation["kind"], string>> = {
  dm: "direct message",
  group: "group",
  topic_group: "topic group",
};

export function buildContextMarkdown(input: {
  readonly channelName: string;
  readonly conversation: Pick<Conversation, "name" | "kind">;
  readonly messages: ReadonlyArray<Message>;
  readonly images: ReadonlyArray<ContextImage>;
  readonly senderName: string;
  readonly senderHistory: ReadonlyArray<SenderHistoryEntry>;
  readonly contextDir: string;
  readonly openUrl: string | null;
  readonly skippedMessages: number;
  /** The reply thread's first message is gone from the adapter; only its replies are here. */
  readonly rootMissing?: boolean;
  /** Whether the channel sends Markdown, which decides how a draft is written. */
  readonly markdown: boolean;
}): string {
  const conversationName = nameOrUnknown(input.conversation.name);
  const lines: string[] = [
    `# ${conversationName}`,
    "",
    ...(input.skippedMessages > 0 ? [skippedLine(input.skippedMessages, "below"), ""] : []),
    ...(input.rootMissing
      ? [
          "The message this reply thread started from is no longer available; only its replies are below.",
          "",
        ]
      : []),
    `- Channel: ${input.channelName}`,
    `- Conversation: ${conversationName} (${KIND_LABEL[input.conversation.kind]})`,
    ...(input.openUrl ? [`- Open in app: ${input.openUrl}`] : []),
    "",
    "## Messages",
    "",
  ];
  const links = new Set<string>();
  for (const message of input.messages) {
    lines.push(
      `### ${nameOrUnknown(message.author.name)}${message.author.isSelf ? " (me)" : ""} · ${message.createdAt}`,
    );
    lines.push("");
    if (message.richSummary) lines.push(`> Rich content: ${message.richSummary}`, "");
    if (message.text.trim().length > 0) lines.push(message.text.trim(), "");
    for (const attachment of message.attachments) {
      const image = input.images.find(
        (candidate) => candidate.messageId === message.id && candidate.key === attachment.key,
      );
      lines.push(
        attachment.kind === "image" && image?.path
          ? `- Image: ${image.path}`
          : `- ${attachment.kind === "image" ? "Image" : "File"} (not downloaded): ${attachment.name}`,
      );
    }
    if (message.attachments.length > 0) lines.push("");
    for (const link of message.links) links.add(link);
  }
  if (links.size > 0) {
    lines.push("## Links", "", ...[...links].map((link) => `- ${link}`), "");
  }
  if (input.senderHistory.length > 0) {
    lines.push(`## Other items from ${nameOrUnknown(input.senderName)} in the last 7 days`, "");
    for (const entry of input.senderHistory) {
      lines.push(
        `- ${entry.at} · ${nameOrUnknown(entry.conversationName)} · ${entry.state}: ${entry.preview}`,
      );
    }
    lines.push("");
  }
  lines.push(writeBackInstructions(input.contextDir, input.markdown), "");
  return lines.join("\n");
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

/** A hash of the message and key, so no two attachments share a file; the type picks the extension. */
export function mediaFileName(messageId: string, key: string, contentType: string | null): string {
  const id = NodeCrypto.createHash("sha256")
    .update(`${messageId}\0${key}`)
    .digest("hex")
    .slice(0, 32);
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return `${id}${IMAGE_EXTENSIONS[type] ?? ".bin"}`;
}
