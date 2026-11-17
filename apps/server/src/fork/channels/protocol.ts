/**
 * Channel protocol v2, the one definition of an adapter's loopback HTTP API; see
 * docs/fork/channel-protocol.md. Lists page with `cursor=<nextCursor>`, newest first; a list
 * item that does not decode is skipped, not the page.
 */
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const CHANNEL_PROTOCOL_VERSION = 2;

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
  /** Optional parts of the protocol the adapter implements; names T3 does not know are ignored. */
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  /** The reaction key T3 adds to a message the user delegates; none is added when absent. */
  ackReaction: Schema.optional(Schema.NullOr(Schema.String)),
});
export type AdapterConfig = typeof AdapterConfig.Type;

const OptionalTimestamp = Schema.NullOr(Timestamp);

export const Conversation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["dm", "group", "topic_group"]),
  name: Schema.String,
  lastActivityAt: Timestamp,
  relevant: Schema.Boolean,
  muted: Schema.Boolean,
  lastMessage: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      createdAt: Timestamp,
      author: Author,
      preview: Schema.String,
    }),
  ),
  /** The newest message on the timeline not from me; replies kept inside a thread do not count. */
  lastOtherMessageAt: OptionalTimestamp,
  lastSelfMessageAt: OptionalTimestamp,
  /** The newest message that mentions me, thread replies included. */
  lastMentionAt: OptionalTimestamp,
  /** The newest message not from me that the chat app shows as read; null when unknown. */
  selfReadThroughAt: Schema.optional(OptionalTimestamp),
  /** The chat app's unread badge, shown as is; null when unknown. */
  unreadCount: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type Conversation = typeof Conversation.Type;

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

/** Who the text names as `@name`; `name` is the text after `@`, exactly as `text` holds it. */
export const MessageMention = Schema.Struct({
  userId: Schema.String,
  name: Schema.String,
  isSelf: Schema.Boolean,
});

export const Reaction = Schema.Struct({
  key: Schema.String,
  emoji: Schema.NullOr(Schema.String),
  count: Schema.Number,
  /** Display names, earliest first; may hold fewer than `count`. */
  users: Schema.Array(Schema.String),
  includesSelf: Schema.Boolean,
});

export const Message = Schema.Struct({
  id: Schema.String,
  createdAt: Timestamp,
  /** The reply thread or topic this message belongs to; null for a root or a lone message. */
  rootId: Schema.optional(Schema.NullOr(Schema.String)),
  /** The message this one answers; author and preview are null when the adapter lacks it. */
  replyTo: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        authorName: Schema.NullOr(Schema.String),
        preview: Schema.NullOr(Schema.String),
      }),
    ),
  ),
  author: Author,
  /** Kept inside its reply thread or topic: the chat app does not show it on the timeline. */
  inThread: Schema.optional(Schema.Boolean),
  mentionsSelf: Schema.Boolean,
  text: Schema.String,
  richSummary: OptionalText,
  attachments: Schema.Array(Attachment),
  links: Schema.Array(Schema.String),
  openUrl: OptionalText,
  format: Schema.optional(Schema.NullOr(Schema.Literals(["text", "markdown"]))),
  mentions: Schema.optional(Schema.NullOr(Schema.Array(MessageMention))),
  reactions: Schema.optional(Schema.NullOr(Schema.Array(Reaction))),
  editedAt: Schema.optional(OptionalTimestamp),
  /** Replies in the thread this message roots, counted by the chat app. */
  replyCount: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type Message = typeof Message.Type;

/** A list page with its items still raw: each item is decoded on its own. */
export const RawPage = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  nextCursor: Schema.NullOr(Schema.String),
});

export const SendResult = Schema.Struct({ messageId: Schema.String });

/** Someone the sent text names as `@name`; `userId` is an `author.id` the adapter reported. */
export const Mention = Schema.Struct({ userId: Schema.String, name: Schema.String });
export type Mention = typeof Mention.Type;

/** A file the adapter holds until a message names it. */
export const Upload = Schema.Struct({
  uploadId: Schema.String,
  kind: LenientAttachmentKind,
  name: Schema.String,
  size: Schema.Number,
});

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
      readonly type: "message.created" | "conversation.updated";
      readonly conversationId?: string;
    }
  | { readonly type: "health.changed" }
  | { readonly type: "connected" };

const decodeConversationEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ conversationId: Schema.optional(Schema.String) })),
);

/** One SSE frame from `/events`. A known event counts even when its data does not parse. */
export function parseChannelEvent(event: string, data: string): ChannelEvent | null {
  if (event === "health.changed") return { type: "health.changed" };
  if (event !== "message.created" && event !== "conversation.updated") return null;
  const named = decodeConversationEvent(data);
  const conversationId = named._tag === "Some" ? named.value.conversationId : undefined;
  return conversationId === undefined ? { type: event } : { type: event, conversationId };
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
