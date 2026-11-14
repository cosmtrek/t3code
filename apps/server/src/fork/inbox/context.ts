import type { Conversation, Message } from "../channels/protocol.ts";

export const CONCLUSION_FILE = "conclusion.md";
export const DRAFT_FILE = "draft.md";
export const CONTEXT_FILE = "context.md";
export const REQUEST_FILE = "request.json";
export const MEDIA_DIR = "media";

function writeBackInstructions(contextDir: string): string {
  return [
    "## Reporting back",
    "",
    `- Write your findings to \`${contextDir}/${CONCLUSION_FILE}\`.`,
    `- Write a reply I can send in the chat to \`${contextDir}/${DRAFT_FILE}\` (plain text, in the language of the conversation).`,
    "- If you cannot write files in that folder, end your last message with `<conclusion>…</conclusion>` and `<draft>…</draft>` holding the same content instead.",
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

export function firstMessage(input: {
  readonly template: string;
  readonly contextDir: string;
  readonly note: string;
  readonly openUrl: string | null;
}): string {
  const body = fillTemplate(input.template, input);
  const parts = [body.trim()];
  if (input.openUrl !== null && !body.includes(input.openUrl)) {
    parts.push(`Open in app: ${input.openUrl}`);
  }
  if (!body.includes(CONCLUSION_FILE) || !body.includes(DRAFT_FILE)) {
    parts.push(writeBackInstructions(input.contextDir));
  }
  return parts.join("\n\n");
}

export function threadTitle(channelName: string, senderName: string, preview: string): string {
  const summary = Array.from(preview.replace(/\s+/g, " ").trim()).slice(0, 20).join("");
  return `${channelName}·${senderName}·${summary}`;
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
  readonly path: string | null;
  readonly name: string;
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
}): string {
  const lines: string[] = [
    `# ${input.conversation.name}`,
    "",
    `- Channel: ${input.channelName}`,
    `- Conversation: ${input.conversation.name} (${KIND_LABEL[input.conversation.kind]})`,
    ...(input.openUrl ? [`- Open in app: ${input.openUrl}`] : []),
    "",
    "## Messages",
    "",
  ];
  const links = new Set<string>();
  for (const message of input.messages) {
    lines.push(
      `### ${message.author.name}${message.author.isSelf ? " (me)" : ""} · ${message.createdAt}`,
    );
    lines.push("");
    if (message.text.trim().length > 0) lines.push(message.text.trim(), "");
    if (message.richSummary) lines.push(`> Rich content: ${message.richSummary}`, "");
    for (const attachment of message.attachments) {
      const image = input.images.find(
        (candidate) => candidate.messageId === message.id && candidate.name === attachment.name,
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
    lines.push(`## Other items from ${input.senderName} in the last 7 days`, "");
    for (const entry of input.senderHistory) {
      lines.push(`- ${entry.at} · ${entry.conversationName} · ${entry.state}: ${entry.preview}`);
    }
    lines.push("");
  }
  lines.push(writeBackInstructions(input.contextDir), "");
  return lines.join("\n");
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
};

export function mediaFileName(messageId: string, key: string, contentType: string | null): string {
  const safe = `${messageId}-${key}`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return `${safe}${IMAGE_EXTENSIONS[type] ?? ".bin"}`;
}
