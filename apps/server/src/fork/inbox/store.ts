// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous; a separate small file keeps fork data out of the main database.
/**
 * The inbox keeps only what it cannot derive: manual done/ignored marks and the links between
 * topics and T3 threads. Its own file, so the main database never carries fork migrations.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export type MarkState = "done" | "ignored";

export interface TopicKey {
  readonly channelId: string;
  readonly conversationId: string;
  readonly topicId: string;
}

export interface Mark extends TopicKey {
  readonly state: MarkState;
  readonly markedAt: string;
  readonly watermarkMessageAt: string;
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
];

type Row = Record<string, NodeSqlite.SQLOutputValue>;

const text = (row: Row, key: string) => String(row[key]);
const nullableText = (row: Row, key: string) => (row[key] === null ? null : String(row[key]));

function toMark(row: Row): Mark {
  return {
    channelId: text(row, "channel_id"),
    conversationId: text(row, "conversation_id"),
    topicId: text(row, "topic_id"),
    state: text(row, "state") as MarkState,
    markedAt: text(row, "marked_at"),
    watermarkMessageAt: text(row, "watermark_message_at"),
  };
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

  listMarks(channelId: string): ReadonlyArray<Mark> {
    return (
      this.db.prepare("SELECT * FROM marks WHERE channel_id = ?").all(channelId) as Row[]
    ).map(toMark);
  }

  setMark(mark: Mark) {
    this.db
      .prepare(
        `INSERT INTO marks (channel_id, conversation_id, topic_id, state, marked_at, watermark_message_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel_id, conversation_id, topic_id) DO UPDATE SET
           state = excluded.state,
           marked_at = excluded.marked_at,
           watermark_message_at = excluded.watermark_message_at`,
      )
      .run(
        mark.channelId,
        mark.conversationId,
        mark.topicId,
        mark.state,
        mark.markedAt,
        mark.watermarkMessageAt,
      );
  }

  clearMark(key: TopicKey) {
    this.db
      .prepare("DELETE FROM marks WHERE channel_id = ? AND conversation_id = ? AND topic_id = ?")
      .run(key.channelId, key.conversationId, key.topicId);
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
