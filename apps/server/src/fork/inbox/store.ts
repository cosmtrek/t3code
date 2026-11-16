// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous; a separate small file keeps fork data out of the main database.
/**
 * The inbox keeps only what it cannot derive: how far each topic has been read and the links
 * between topics and T3 threads. Its own file, so the main database never carries fork migrations.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export interface TopicKey {
  readonly channelId: string;
  readonly conversationId: string;
  readonly topicId: string;
}

export interface Read extends TopicKey {
  /** The newest message seen, by its own time. */
  readonly readAt: string | null;
  /** When the thread's last run the user saw had finished. */
  readonly agentSeenAt: string | null;
  readonly pinnedUnread: boolean;
}

export interface Link extends TopicKey {
  readonly itemId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly detachedAt: string | null;
  readonly detachedReason: string | null;
}

/** Forward-only; each entry moves `user_version` up by one. */
const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE marks (
     channel_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     topic_id TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('done', 'ignored')),
     marked_at TEXT NOT NULL,
     watermark_message_at TEXT NOT NULL,
     PRIMARY KEY (channel_id, conversation_id, topic_id)
   );
   CREATE TABLE links (
     item_id TEXT NOT NULL,
     channel_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     topic_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     created_at TEXT NOT NULL,
     detached_at TEXT,
     detached_reason TEXT,
     PRIMARY KEY (item_id, thread_id)
   );
   CREATE INDEX links_by_channel ON links (channel_id, detached_at);`,
  `CREATE TABLE reads (
     channel_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     topic_id TEXT NOT NULL,
     read_at TEXT,
     agent_seen_at TEXT,
     pinned_unread INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (channel_id, conversation_id, topic_id)
   );
   CREATE TABLE channel_reads (
     channel_id TEXT PRIMARY KEY,
     read_all_before TEXT NOT NULL
   );
   INSERT INTO reads (channel_id, conversation_id, topic_id, read_at)
     SELECT channel_id, conversation_id, topic_id, watermark_message_at FROM marks;
   DROP TABLE marks;`,
];

type Row = Record<string, NodeSqlite.SQLOutputValue>;

const text = (row: Row, key: string) => String(row[key]);
const nullableText = (row: Row, key: string) => (row[key] === null ? null : String(row[key]));

function toRead(row: Row): Read {
  return {
    channelId: text(row, "channel_id"),
    conversationId: text(row, "conversation_id"),
    topicId: text(row, "topic_id"),
    readAt: nullableText(row, "read_at"),
    agentSeenAt: nullableText(row, "agent_seen_at"),
    pinnedUnread: Number(row.pinned_unread) === 1,
  };
}

/** Adapters may write offsets, so times compare as instants, not strings. */
function later(current: string | null, next: string | undefined): string | null {
  if (next === undefined) return current;
  if (current === null) return next;
  return Date.parse(next) > Date.parse(current) ? next : current;
}

function toLink(row: Row): Link {
  return {
    itemId: text(row, "item_id"),
    channelId: text(row, "channel_id"),
    conversationId: text(row, "conversation_id"),
    topicId: text(row, "topic_id"),
    threadId: text(row, "thread_id"),
    projectId: text(row, "project_id"),
    createdAt: text(row, "created_at"),
    detachedAt: nullableText(row, "detached_at"),
    detachedReason: nullableText(row, "detached_reason"),
  };
}

export class InboxStore {
  private readonly db: NodeSqlite.DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ":memory:") NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
    this.db = new NodeSqlite.DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    const version = Number(
      (this.db.prepare("PRAGMA user_version").get() as Row | undefined)?.user_version ?? 0,
    );
    if (version > MIGRATIONS.length) {
      throw new Error(
        `inbox.sqlite is at version ${version}, newer than this build knows (${MIGRATIONS.length}).`,
      );
    }
    for (let index = version; index < MIGRATIONS.length; index++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[index]!);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close() {
    this.db.close();
  }

  listReads(channelId: string): ReadonlyArray<Read> {
    return (
      this.db.prepare("SELECT * FROM reads WHERE channel_id = ?").all(channelId) as Row[]
    ).map(toRead);
  }

  private getRead(key: TopicKey): Read | null {
    const row = this.db
      .prepare("SELECT * FROM reads WHERE channel_id = ? AND conversation_id = ? AND topic_id = ?")
      .get(key.channelId, key.conversationId, key.topicId) as Row | undefined;
    return row ? toRead(row) : null;
  }

  private putRead(read: Read) {
    this.db
      .prepare(
        `INSERT INTO reads (channel_id, conversation_id, topic_id, read_at, agent_seen_at, pinned_unread)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel_id, conversation_id, topic_id) DO UPDATE SET
           read_at = excluded.read_at,
           agent_seen_at = excluded.agent_seen_at,
           pinned_unread = excluded.pinned_unread`,
      )
      .run(
        read.channelId,
        read.conversationId,
        read.topicId,
        read.readAt,
        read.agentSeenAt,
        read.pinnedUnread ? 1 : 0,
      );
  }

  /** Both marks only move forward: a stale client view never unreads what was seen. */
  markRead(key: TopicKey, seen: { readonly readAt?: string; readonly agentSeenAt?: string }) {
    const current = this.getRead(key);
    this.putRead({
      channelId: key.channelId,
      conversationId: key.conversationId,
      topicId: key.topicId,
      readAt: later(current?.readAt ?? null, seen.readAt),
      agentSeenAt: later(current?.agentSeenAt ?? null, seen.agentSeenAt),
      pinnedUnread: false,
    });
  }

  pinUnread(key: TopicKey) {
    const current = this.getRead(key);
    this.putRead({
      channelId: key.channelId,
      conversationId: key.conversationId,
      topicId: key.topicId,
      readAt: current?.readAt ?? null,
      agentSeenAt: current?.agentSeenAt ?? null,
      pinnedUnread: true,
    });
  }

  /** Everything before it counts as read; set to `initial` the first time a channel is read. */
  readAllBefore(channelId: string, initial: string): string {
    this.db
      .prepare("INSERT OR IGNORE INTO channel_reads (channel_id, read_all_before) VALUES (?, ?)")
      .run(channelId, initial);
    const row = this.db
      .prepare("SELECT read_all_before FROM channel_reads WHERE channel_id = ?")
      .get(channelId) as { read_all_before: string };
    return row.read_all_before;
  }

  markAllRead(channelId: string, before: string) {
    const current = this.readAllBefore(channelId, before);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE channel_reads SET read_all_before = ? WHERE channel_id = ?")
        .run(later(current, before), channelId);
      this.db.prepare("UPDATE reads SET pinned_unread = 0 WHERE channel_id = ?").run(channelId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every link of the channel, detached ones included, newest first. */
  listLinks(channelId: string): ReadonlyArray<Link> {
    return (
      this.db
        .prepare("SELECT * FROM links WHERE channel_id = ? ORDER BY created_at DESC")
        .all(channelId) as Row[]
    ).map(toLink);
  }

  linksForItem(itemId: string): ReadonlyArray<Link> {
    return (
      this.db
        .prepare("SELECT * FROM links WHERE item_id = ? ORDER BY created_at DESC")
        .all(itemId) as Row[]
    ).map(toLink);
  }

  /** The channel whose item this thread works on, while the link is attached. */
  channelOfThread(threadId: string): string | null {
    const row = this.db
      .prepare("SELECT channel_id FROM links WHERE thread_id = ? AND detached_at IS NULL LIMIT 1")
      .get(threadId) as { channel_id: string } | undefined;
    return row?.channel_id ?? null;
  }

  addLink(link: Omit<Link, "detachedAt" | "detachedReason">) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO links
           (item_id, channel_id, conversation_id, topic_id, thread_id, project_id, created_at, detached_at, detached_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        link.itemId,
        link.channelId,
        link.conversationId,
        link.topicId,
        link.threadId,
        link.projectId,
        link.createdAt,
      );
  }

  detachLink(itemId: string, threadId: string, reason: string, at: string) {
    this.db
      .prepare(
        `UPDATE links SET detached_at = ?, detached_reason = ?
         WHERE item_id = ? AND thread_id = ? AND detached_at IS NULL`,
      )
      .run(at, reason, itemId, threadId);
  }
}
