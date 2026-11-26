// @effect-diagnostics nodeBuiltinImport:off - Only the sqlite row type, from the store the core opens.
/**
 * What the chat connector keeps in `bots.sqlite`: mentions already given to a bot, and messages
 * bots sent as the user, so those never count as the user writing.
 */
import type * as NodeSqlite from "node:sqlite";

import type { BotStore } from "../../store.ts";

/** Per conversation: mentions of the user already given to a bot, and one waiting its delay. */
export interface MentionMark {
  readonly channelId: string;
  readonly conversationId: string;
  /** Mentions at or before this are handled. */
  readonly handledThrough: string;
  /** The newest mention seen and not yet handled; null when none waits. */
  readonly pendingAt: string | null;
  readonly dueAt: string | null;
}

type Row = Record<string, NodeSqlite.SQLOutputValue>;

const nullableText = (row: Row, key: string) => (row[key] === null ? null : String(row[key]));

const toMention = (row: Row): MentionMark => ({
  channelId: String(row.channel_id),
  conversationId: String(row.conversation_id),
  handledThrough: String(row.handled_through),
  pendingAt: nullableText(row, "pending_at"),
  dueAt: nullableText(row, "due_at"),
});

export const recordSent = (
  store: BotStore,
  botId: string,
  channelId: string,
  messageId: string,
  at: string,
) =>
  store.db
    .prepare(
      "INSERT OR IGNORE INTO sent_messages (channel_id, message_id, bot_id, sent_at) VALUES (?, ?, ?, ?)",
    )
    .run(channelId, messageId, botId, at);

export const sentByBots = (
  store: BotStore,
  channelId: string,
  messageIds: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const check = store.db.prepare(
    "SELECT 1 FROM sent_messages WHERE channel_id = ? AND message_id = ?",
  );
  return new Set(messageIds.filter((id) => check.get(channelId, id) !== undefined));
};

export const listMentions = (store: BotStore, channelId: string): ReadonlyArray<MentionMark> =>
  (store.db.prepare("SELECT * FROM mentions WHERE channel_id = ?").all(channelId) as Row[]).map(
    toMention,
  );

export const dueMentions = (store: BotStore, at: string): ReadonlyArray<MentionMark> =>
  (
    store.db
      .prepare("SELECT * FROM mentions WHERE due_at IS NOT NULL AND due_at <= ? ORDER BY due_at")
      .all(at) as Row[]
  ).map(toMention);

/** A newer mention waits; the first one sets when it is due, later ones join it. */
export const markMentionPending = (
  store: BotStore,
  channelId: string,
  conversationId: string,
  pendingAt: string,
  dueAt: string,
  handledThrough: string,
) =>
  store.db
    .prepare(
      `INSERT INTO mentions (channel_id, conversation_id, handled_through, pending_at, due_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (channel_id, conversation_id) DO UPDATE SET
         pending_at = excluded.pending_at,
         due_at = COALESCE(mentions.due_at, excluded.due_at)`,
    )
    .run(channelId, conversationId, handledThrough, pendingAt, dueAt);

/** Tries a due mention again later, when the channel could not be read. */
export const delayMention = (
  store: BotStore,
  channelId: string,
  conversationId: string,
  dueAt: string,
) =>
  store.db
    .prepare("UPDATE mentions SET due_at = ? WHERE channel_id = ? AND conversation_id = ?")
    .run(dueAt, channelId, conversationId);

/** `through` is the caller's latest of the old mark and the new one. */
export const markMentionHandled = (
  store: BotStore,
  channelId: string,
  conversationId: string,
  through: string,
) =>
  store.db
    .prepare(
      `INSERT INTO mentions (channel_id, conversation_id, handled_through) VALUES (?, ?, ?)
       ON CONFLICT (channel_id, conversation_id) DO UPDATE SET
         handled_through = excluded.handled_through, pending_at = NULL, due_at = NULL`,
    )
    .run(channelId, conversationId, through);
