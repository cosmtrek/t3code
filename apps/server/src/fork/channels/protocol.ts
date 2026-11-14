/**
 * Channel protocol v1: what an adapter answers on its loopback HTTP API. Unknown keys are
 * ignored, so an adapter may add fields; a different major `protocol` disables the channel.
 */
import * as Schema from "effect/Schema";

export const CHANNEL_PROTOCOL_VERSION = 1;

const Author = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isSelf: Schema.Boolean,
});

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

export const ProtocolProbe = Schema.Struct({ protocol: Schema.Number });

export const ChannelHealth = Schema.Struct({
  protocol: Schema.Number,
  adapterVersion: Schema.String,
  online: Schema.Boolean,
  loggedIn: Schema.Boolean,
  lastSyncAt: Schema.NullOr(Schema.String),
  self: Schema.Struct({ id: Schema.String, name: Schema.String }),
  logsUrl: OptionalText,
  lastError: OptionalText,
});
export type ChannelHealth = typeof ChannelHealth.Type;

export const DelegateTemplate = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
});
export type DelegateTemplate = typeof DelegateTemplate.Type;

export const AdapterConfig = Schema.Struct({
  displayName: Schema.String,
  icon: OptionalText,
  defaultProjectPaths: Schema.Array(Schema.String),
  delegateTemplates: Schema.Array(DelegateTemplate),
  relevanceSummary: Schema.String,
});
export type AdapterConfig = typeof AdapterConfig.Type;

export const Conversation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["dm", "group", "topic_group"]),
  name: Schema.String,
  lastActivityAt: Schema.String,
  relevant: Schema.Boolean,
  muted: Schema.Boolean,
});
export type Conversation = typeof Conversation.Type;

export const Topic = Schema.Struct({
  id: Schema.String,
  rootMessageId: Schema.String,
  rootPreview: Schema.String,
  replyCount: Schema.Number,
  lastMessageAt: Schema.String,
  lastAuthor: Author,
  participatedBySelf: Schema.Boolean,
});
export type Topic = typeof Topic.Type;

export const Attachment = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["image", "file"]),
  name: Schema.String,
});

export const Message = Schema.Struct({
  id: Schema.String,
  topicId: Schema.String,
  createdAt: Schema.String,
  author: Author,
  mentionsSelf: Schema.Boolean,
  text: Schema.String,
  richSummary: OptionalText,
  attachments: Schema.Array(Attachment),
  links: Schema.Array(Schema.String),
  openUrl: OptionalText,
});
export type Message = typeof Message.Type;

export const page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Schema.String) });

export const SendResult = Schema.Struct({ messageId: Schema.String });

export const SendErrorCode = Schema.Literals([
  "not_logged_in",
  "rate_limited",
  "rejected",
  "unknown",
]);
export type SendErrorCode = typeof SendErrorCode.Type;

export const AdapterError = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

export type ChannelEvent =
  | {
      readonly type: "message.created";
      readonly conversationId: string;
      readonly topicId: string;
      readonly messageId: string;
    }
  | { readonly type: "health.changed" };

const MessageCreated = Schema.Struct({
  conversationId: Schema.String,
  topicId: Schema.String,
  messageId: Schema.String,
});
const decodeMessageCreated = Schema.decodeUnknownOption(MessageCreated);

/** One SSE frame from `/events`; frames this version does not know are dropped. */
export function parseChannelEvent(event: string, data: string): ChannelEvent | null {
  if (event === "health.changed") return { type: "health.changed" };
  if (event !== "message.created") return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const decoded = decodeMessageCreated(json);
  return decoded._tag === "Some" ? { type: "message.created", ...decoded.value } : null;
}

/** Splits an SSE byte stream into (event, data) frames. Keeps a partial frame between chunks. */
export function createSseParser(onFrame: (event: string, data: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk.replace(/\r\n?/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0 || event !== "message") onFrame(event, data.join("\n"));
      boundary = buffer.indexOf("\n\n");
    }
  };
}
