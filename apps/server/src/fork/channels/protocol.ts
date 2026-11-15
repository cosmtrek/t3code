/**
 * Channel protocol v1, the one definition of an adapter's loopback HTTP API; see
 * docs/fork/channel-protocol.md. Lists page with `cursor=<nextCursor>`, newest first; a list
 * item that does not decode is skipped, not the page. DMs are split into topics by the adapter.
 */
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const CHANNEL_PROTOCOL_VERSION = 1;

const Author = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isSelf: Schema.Boolean,
});

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));

/** ISO 8601 with a time zone (`Z` or an offset), so times compare across adapters. */
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u),
);

export const ProtocolProbe = Schema.Struct({ protocol: Schema.Number });

export const ChannelHealth = Schema.Struct({
  protocol: Schema.Number,
  adapterVersion: Schema.String,
  online: Schema.Boolean,
  loggedIn: Schema.Boolean,
  lastSyncAt: Schema.NullOr(Timestamp),
  self: Schema.Struct({ name: Schema.String }),
  logsUrl: OptionalText,
  lastError: OptionalText,
});
export type ChannelHealth = typeof ChannelHealth.Type;

/** Only a prompt: the thread runs in the project's default mode, whatever the prompt asks. */
export const DelegateTemplate = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  prompt: Schema.String,
});
export type DelegateTemplate = typeof DelegateTemplate.Type;

export const AdapterConfig = Schema.Struct({
  displayName: Schema.String,
  defaultProjectPaths: Schema.Array(Schema.String),
  delegateTemplates: Schema.Array(DelegateTemplate),
  relevanceSummary: Schema.String,
});
export type AdapterConfig = typeof AdapterConfig.Type;

export const Conversation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["dm", "group", "topic_group"]),
  name: Schema.String,
  lastActivityAt: Timestamp,
  relevant: Schema.Boolean,
  muted: Schema.Boolean,
});
export type Conversation = typeof Conversation.Type;

export const Topic = Schema.Struct({
  id: Schema.String,
  rootMessageId: Schema.String,
  rootPreview: Schema.String,
  replyCount: Schema.Number,
  lastMessageAt: Timestamp,
  lastAuthor: Author,
  participatedBySelf: Schema.Boolean,
  /** The newest message not from me; null when I wrote every one. */
  lastOtherMessageAt: Schema.NullOr(Timestamp),
  /** Whether a message after my last one (or any, if I never wrote) mentions me. */
  mentionsSelfSinceOwn: Schema.Boolean,
});
export type Topic = typeof Topic.Type;

const AttachmentKind = Schema.Literals(["image", "file"]);

/** Chats add kinds (audio, video, sticker); an unknown one shows as a file, not a lost message. */
const LenientAttachmentKind = Schema.String.pipe(
  Schema.decodeTo(
    AttachmentKind,
    SchemaTransformation.transform({
      decode: (kind) => (kind === "image" ? "image" : "file"),
      encode: (kind) => kind,
    }),
  ),
);

export const Attachment = Schema.Struct({
  key: Schema.String,
  kind: LenientAttachmentKind,
  name: Schema.String,
});

export const Message = Schema.Struct({
  id: Schema.String,
  topicId: Schema.String,
  createdAt: Timestamp,
  author: Author,
  mentionsSelf: Schema.Boolean,
  text: Schema.String,
  richSummary: OptionalText,
  attachments: Schema.Array(Attachment),
  links: Schema.Array(Schema.String),
  openUrl: OptionalText,
});
export type Message = typeof Message.Type;

/** A list page with its items still raw: each item is decoded on its own. */
export const RawPage = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  nextCursor: Schema.NullOr(Schema.String),
});

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

/**
 * Events only say that something changed; T3 then reads again. `connected` is T3's own, sent
 * each time the stream opens, since anything may have changed while it was closed.
 */
export type ChannelEvent =
  | {
      readonly type: "message.created";
      readonly conversationId?: string;
      readonly topicId?: string;
    }
  | { readonly type: "health.changed" }
  | { readonly type: "connected" };

const decodeMessageCreated = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      conversationId: Schema.optional(Schema.String),
      topicId: Schema.optional(Schema.String),
    }),
  ),
);

/** One SSE frame from `/events`. A known event counts even when its data does not parse. */
export function parseChannelEvent(event: string, data: string): ChannelEvent | null {
  if (event === "health.changed") return { type: "health.changed" };
  if (event !== "message.created") return null;
  const named = decodeMessageCreated(data);
  if (named._tag === "None") return { type: "message.created" };
  const { conversationId, topicId } = named.value;
  return {
    type: "message.created",
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(topicId === undefined ? {} : { topicId }),
  };
}

/** Splits an SSE byte stream into (event, data) frames. Keeps a partial frame between chunks. */
export function createSseParser(onFrame: (event: string, data: string) => void) {
  let buffer = "";
  // A CRLF split across chunks must not read as two line ends.
  let endedWithCr = false;
  return (input: string) => {
    const chunk = endedWithCr && input.startsWith("\n") ? input.slice(1) : input;
    endedWithCr = chunk.endsWith("\r");
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
