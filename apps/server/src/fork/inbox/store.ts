// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous; a separate small file keeps fork data out of the main database.
/**
 * The inbox keeps only what it cannot derive: how far each conversation has been read, the
 * delegations made from its messages, and the links between delegations and T3 threads. Its own
 * file, so the main database never carries fork migrations.
 */
import * as NodeSqlite from "node:sqlite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export interface ConversationKey {
  readonly channelId: string;
  readonly conversationId: string;
}

export interface ConversationRead extends ConversationKey {
  /** The newest message seen, by its own time. */
  readonly readAt: string | null;
  readonly pinnedUnread: boolean;
}

/**
 * `chain` is the anchor and every reply under it. `range` runs from the anchor through
 * `untilAt`. Null comes from a v1 topic and is read by the conversation's kind.
 */
export type DelegationScope = "chain" | "range";

export interface Delegation extends ConversationKey {
  readonly id: string;
  readonly anchorMessageId: string;
  readonly scope: DelegationScope | null;
  readonly untilAt: string | null;
  /** The anchor's text when delegated; null for one made from a v1 topic. */
  readonly preview: string | null;
  readonly createdAt: string;
  /** When the thread's last run the user saw had finished. */
  readonly agentSeenAt: string | null;
  /** When the user marked it done; null while it is open. */
  readonly settledAt: string | null;
}

export interface Link extends ConversationKey {
  readonly delegationId: string;
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
  // Protocol v2 drops topics. A v1 topic id is its first message's id, so a linked topic becomes
  // a delegation anchored there and keeps its id and folder. MAX compares strings: adapters
  // write one zone, and a mark that lands early only shows a message as unread again.
  `CREATE TABLE conversation_reads (
     channel_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     read_at TEXT,
     pinned_unread INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (channel_id, conversation_id)
   );
   INSERT INTO conversation_reads (channel_id, conversation_id, read_at, pinned_unread)
     SELECT channel_id, conversation_id, MAX(read_at), MAX(pinned_unread)
     FROM reads GROUP BY channel_id, conversation_id;
   CREATE TABLE delegations (
     id TEXT PRIMARY KEY,
     channel_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     anchor_message_id TEXT NOT NULL,
     scope TEXT CHECK (scope IN ('chain', 'range')),
     until_at TEXT,
     preview TEXT,
     created_at TEXT NOT NULL,
     agent_seen_at TEXT
   );
   CREATE INDEX delegations_by_channel ON delegations (channel_id);
   INSERT INTO delegations (id, channel_id, conversation_id, anchor_message_id, created_at, agent_seen_at)
     SELECT links.item_id, links.channel_id, links.conversation_id, links.topic_id,
       MIN(links.created_at), MAX(reads.agent_seen_at)
     FROM links LEFT JOIN reads ON reads.channel_id = links.channel_id
       AND reads.conversation_id = links.conversation_id AND reads.topic_id = links.topic_id
     GROUP BY links.item_id;
   ALTER TABLE links DROP COLUMN topic_id;
   ALTER TABLE links RENAME COLUMN item_id TO delegation_id;
   DROP TABLE reads;`,
  `ALTER TABLE delegations ADD COLUMN settled_at TEXT;`,
];

type Row = Record<string, NodeSqlite.SQLOutputValue>;

const text = (row: Row, key: string) => String(row[key]);
const nullableText = (row: Row, key: string) => (row[key] === null ? null : String(row[key]));

function toConversationRead(row: Row): ConversationRead {
  return {
    channelId: text(row, "channel_id"),
    conversationId: text(row, "conversation_id"),
    readAt: nullableText(row, "read_at"),
    pinnedUnread: Number(row.pinned_unread) === 1,
  };
}

function toDelegation(row: Row): Delegation {
  const scope = nullableText(row, "scope");
  return {
    id: text(row, "id"),
    channelId: text(row, "channel_id"),
    conversationId: text(row, "conversation_id"),
    anchorMessageId: text(row, "anchor_message_id"),
    scope: scope === "chain" || scope === "range" ? scope : null,
    untilAt: nullableText(row, "until_at"),
    preview: nullableText(row, "preview"),
    createdAt: text(row, "created_at"),
    agentSeenAt: nullableText(row, "agent_seen_at"),
    settledAt: nullableText(row, "settled_at"),
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
    delegationId: text(row, "delegation_id"),
    channelId: text(row, "channel_id"),
    conversationId: text(row, "conversation_id"),
    threadId: text(row, "thread_id"),
    projectId: text(row, "project_id"),
    createdAt: text(row, "created_at"),
    detachedAt: nullableText(row, "detached_at"),
    detachedReason: nullableText(row, "detached_reason"),
  };
}

export class InboxStoreError extends Schema.TaggedError<InboxStoreError>()("InboxStoreError", {
  operation: Schema.String,
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return "The inbox database operation failed.";
  }
}

export class InboxStore extends Context.Service<
  InboxStore,
  {
    readonly listConversationReads: (
      ...args: Parameters<InboxDatabase["listConversationReads"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["listConversationReads"]>, InboxStoreError>;
    readonly markConversationRead: (
      ...args: Parameters<InboxDatabase["markConversationRead"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["markConversationRead"]>, InboxStoreError>;
    readonly pinConversationUnread: (
      ...args: Parameters<InboxDatabase["pinConversationUnread"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["pinConversationUnread"]>, InboxStoreError>;
    readonly readAllBefore: (
      ...args: Parameters<InboxDatabase["readAllBefore"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["readAllBefore"]>, InboxStoreError>;
    readonly markAllRead: (
      ...args: Parameters<InboxDatabase["markAllRead"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["markAllRead"]>, InboxStoreError>;
    readonly listDelegations: (
      ...args: Parameters<InboxDatabase["listDelegations"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["listDelegations"]>, InboxStoreError>;
    readonly getDelegation: (
      ...args: Parameters<InboxDatabase["getDelegation"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["getDelegation"]>, InboxStoreError>;
    readonly saveDelegation: (
      ...args: Parameters<InboxDatabase["saveDelegation"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["saveDelegation"]>, InboxStoreError>;
    readonly markAgentSeen: (
      ...args: Parameters<InboxDatabase["markAgentSeen"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["markAgentSeen"]>, InboxStoreError>;
    readonly setSettled: (
      ...args: Parameters<InboxDatabase["setSettled"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["setSettled"]>, InboxStoreError>;
    readonly listLinks: (
      ...args: Parameters<InboxDatabase["listLinks"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["listLinks"]>, InboxStoreError>;
    readonly linksForDelegation: (
      ...args: Parameters<InboxDatabase["linksForDelegation"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["linksForDelegation"]>, InboxStoreError>;
    readonly channelOfThread: (
      ...args: Parameters<InboxDatabase["channelOfThread"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["channelOfThread"]>, InboxStoreError>;
    readonly addLink: (
      ...args: Parameters<InboxDatabase["addLink"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["addLink"]>, InboxStoreError>;
    readonly detachLink: (
      ...args: Parameters<InboxDatabase["detachLink"]>
    ) => Effect.Effect<ReturnType<InboxDatabase["detachLink"]>, InboxStoreError>;
    readonly close: () => Effect.Effect<void, InboxStoreError>;
  }
>()("t3/fork/inbox/store/InboxStore") {}

class InboxDatabase {
  private readonly db: NodeSqlite.DatabaseSync;
  constructor(db: NodeSqlite.DatabaseSync) {
    this.db = db;
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
      this.transaction(() => {
        this.db.exec(MIGRATIONS[index]!);
        this.db.exec(`PRAGMA user_version = ${index + 1}`);
      });
    }
  }

  private transaction(run: () => void) {
    this.db.exec("BEGIN");
    try {
      run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listConversationReads(channelId: string): ReadonlyArray<ConversationRead> {
    return (
      this.db
        .prepare("SELECT * FROM conversation_reads WHERE channel_id = ?")
        .all(channelId) as Row[]
    ).map(toConversationRead);
  }

  private getConversationRead(key: ConversationKey): ConversationRead | null {
    const row = this.db
      .prepare("SELECT * FROM conversation_reads WHERE channel_id = ? AND conversation_id = ?")
      .get(key.channelId, key.conversationId) as Row | undefined;
    return row ? toConversationRead(row) : null;
  }

  private putConversationRead(read: ConversationRead) {
    this.db
      .prepare(
        `INSERT INTO conversation_reads (channel_id, conversation_id, read_at, pinned_unread)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (channel_id, conversation_id) DO UPDATE SET
           read_at = excluded.read_at,
           pinned_unread = excluded.pinned_unread`,
      )
      .run(read.channelId, read.conversationId, read.readAt, read.pinnedUnread ? 1 : 0);
  }

  /** Only moves forward: a stale client view never unreads what was seen. */
  markConversationRead(key: ConversationKey, readAt: string | undefined) {
    const current = this.getConversationRead(key);
    this.putConversationRead({
      ...key,
      readAt: later(current?.readAt ?? null, readAt),
      pinnedUnread: false,
    });
  }

  pinConversationUnread(key: ConversationKey) {
    const current = this.getConversationRead(key);
    this.putConversationRead({ ...key, readAt: current?.readAt ?? null, pinnedUnread: true });
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
    this.transaction(() => {
      this.db
        .prepare("UPDATE channel_reads SET read_all_before = ? WHERE channel_id = ?")
        .run(later(current, before), channelId);
      this.db
        .prepare("UPDATE conversation_reads SET pinned_unread = 0 WHERE channel_id = ?")
        .run(channelId);
    });
  }

  listDelegations(channelId: string): ReadonlyArray<Delegation> {
    return (
      this.db
        .prepare("SELECT * FROM delegations WHERE channel_id = ? ORDER BY created_at DESC")
        .all(channelId) as Row[]
    ).map(toDelegation);
  }

  getDelegation(id: string): Delegation | null {
    const row = this.db.prepare("SELECT * FROM delegations WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toDelegation(row) : null;
  }

  /** A new delegation, or the same anchor delegated again (which reopens it) with its range now. */
  saveDelegation(
    delegation: Omit<Delegation, "agentSeenAt" | "createdAt" | "settledAt"> & {
      readonly createdAt: string;
    },
  ) {
    this.db
      .prepare(
        `INSERT INTO delegations
           (id, channel_id, conversation_id, anchor_message_id, scope, until_at, preview, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           scope = excluded.scope,
           until_at = excluded.until_at,
           preview = COALESCE(excluded.preview, delegations.preview),
           settled_at = NULL`,
      )
      .run(
        delegation.id,
        delegation.channelId,
        delegation.conversationId,
        delegation.anchorMessageId,
        delegation.scope,
        delegation.untilAt,
        delegation.preview,
        delegation.createdAt,
      );
  }

  /** Only moves forward, as reads do. */
  markAgentSeen(id: string, at: string) {
    const current = this.getDelegation(id);
    if (current === null) return;
    this.db
      .prepare("UPDATE delegations SET agent_seen_at = ? WHERE id = ?")
      .run(later(current.agentSeenAt, at), id);
  }

  setSettled(id: string, at: string | null) {
    this.db.prepare("UPDATE delegations SET settled_at = ? WHERE id = ?").run(at, id);
  }

  /** Every link of the channel, detached ones included, newest first. */
  listLinks(channelId: string): ReadonlyArray<Link> {
    return (
      this.db
        .prepare("SELECT * FROM links WHERE channel_id = ? ORDER BY created_at DESC")
        .all(channelId) as Row[]
    ).map(toLink);
  }

  linksForDelegation(delegationId: string): ReadonlyArray<Link> {
    return (
      this.db
        .prepare("SELECT * FROM links WHERE delegation_id = ? ORDER BY created_at DESC")
        .all(delegationId) as Row[]
    ).map(toLink);
  }

  /** The channel whose delegation this thread works on, while the link is attached. */
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
           (delegation_id, channel_id, conversation_id, thread_id, project_id, created_at, detached_at, detached_reason)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        link.delegationId,
        link.channelId,
        link.conversationId,
        link.threadId,
        link.projectId,
        link.createdAt,
      );
  }

  detachLink(delegationId: string, threadId: string, reason: string, at: string) {
    this.db
      .prepare(
        `UPDATE links SET detached_at = ?, detached_reason = ?
         WHERE delegation_id = ? AND thread_id = ? AND detached_at IS NULL`,
      )
      .run(at, reason, delegationId, threadId);
  }
}

export const make = Effect.fn("InboxStore.make")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (filePath !== ":memory:") {
    yield* fs
      .makeDirectory(path.dirname(filePath), { recursive: true })
      .pipe(
        Effect.mapError(
          (cause) => new InboxStoreError({ operation: "mkdir", path: filePath, cause }),
        ),
      );
  }
  const { database, close } = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const db = new NodeSqlite.DatabaseSync(filePath);
        let database: InboxDatabase;
        try {
          database = new InboxDatabase(db);
        } catch (cause) {
          db.close();
          throw cause;
        }
        let closed = false;
        const close = Effect.fn("InboxStore.close")(() =>
          Effect.try({
            try: () => {
              if (!closed) {
                db.close();
                closed = true;
              }
            },
            catch: (cause) => new InboxStoreError({ operation: "close", path: filePath, cause }),
          }),
        );
        return { database, close };
      },
      catch: (cause) => new InboxStoreError({ operation: "open", path: filePath, cause }),
    }),
    ({ close }) => close().pipe(Effect.orDie),
  );
  return InboxStore.of({
    close,
    listConversationReads: Effect.fn("InboxStore.listConversationReads")(
      (...args: Parameters<InboxDatabase["listConversationReads"]>) =>
        Effect.try({
          try: () => database.listConversationReads(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "listConversationReads", path: filePath, cause }),
        }),
    ),
    markConversationRead: Effect.fn("InboxStore.markConversationRead")(
      (...args: Parameters<InboxDatabase["markConversationRead"]>) =>
        Effect.try({
          try: () => database.markConversationRead(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "markConversationRead", path: filePath, cause }),
        }),
    ),
    pinConversationUnread: Effect.fn("InboxStore.pinConversationUnread")(
      (...args: Parameters<InboxDatabase["pinConversationUnread"]>) =>
        Effect.try({
          try: () => database.pinConversationUnread(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "pinConversationUnread", path: filePath, cause }),
        }),
    ),
    readAllBefore: Effect.fn("InboxStore.readAllBefore")(
      (...args: Parameters<InboxDatabase["readAllBefore"]>) =>
        Effect.try({
          try: () => database.readAllBefore(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "readAllBefore", path: filePath, cause }),
        }),
    ),
    markAllRead: Effect.fn("InboxStore.markAllRead")(
      (...args: Parameters<InboxDatabase["markAllRead"]>) =>
        Effect.try({
          try: () => database.markAllRead(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "markAllRead", path: filePath, cause }),
        }),
    ),
    listDelegations: Effect.fn("InboxStore.listDelegations")(
      (...args: Parameters<InboxDatabase["listDelegations"]>) =>
        Effect.try({
          try: () => database.listDelegations(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "listDelegations", path: filePath, cause }),
        }),
    ),
    getDelegation: Effect.fn("InboxStore.getDelegation")(
      (...args: Parameters<InboxDatabase["getDelegation"]>) =>
        Effect.try({
          try: () => database.getDelegation(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "getDelegation", path: filePath, cause }),
        }),
    ),
    saveDelegation: Effect.fn("InboxStore.saveDelegation")(
      (...args: Parameters<InboxDatabase["saveDelegation"]>) =>
        Effect.try({
          try: () => database.saveDelegation(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "saveDelegation", path: filePath, cause }),
        }),
    ),
    markAgentSeen: Effect.fn("InboxStore.markAgentSeen")(
      (...args: Parameters<InboxDatabase["markAgentSeen"]>) =>
        Effect.try({
          try: () => database.markAgentSeen(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "markAgentSeen", path: filePath, cause }),
        }),
    ),
    setSettled: Effect.fn("InboxStore.setSettled")(
      (...args: Parameters<InboxDatabase["setSettled"]>) =>
        Effect.try({
          try: () => database.setSettled(...args),
          catch: (cause) => new InboxStoreError({ operation: "setSettled", path: filePath, cause }),
        }),
    ),
    listLinks: Effect.fn("InboxStore.listLinks")(
      (...args: Parameters<InboxDatabase["listLinks"]>) =>
        Effect.try({
          try: () => database.listLinks(...args),
          catch: (cause) => new InboxStoreError({ operation: "listLinks", path: filePath, cause }),
        }),
    ),
    linksForDelegation: Effect.fn("InboxStore.linksForDelegation")(
      (...args: Parameters<InboxDatabase["linksForDelegation"]>) =>
        Effect.try({
          try: () => database.linksForDelegation(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "linksForDelegation", path: filePath, cause }),
        }),
    ),
    channelOfThread: Effect.fn("InboxStore.channelOfThread")(
      (...args: Parameters<InboxDatabase["channelOfThread"]>) =>
        Effect.try({
          try: () => database.channelOfThread(...args),
          catch: (cause) =>
            new InboxStoreError({ operation: "channelOfThread", path: filePath, cause }),
        }),
    ),
    addLink: Effect.fn("InboxStore.addLink")((...args: Parameters<InboxDatabase["addLink"]>) =>
      Effect.try({
        try: () => database.addLink(...args),
        catch: (cause) => new InboxStoreError({ operation: "addLink", path: filePath, cause }),
      }),
    ),
    detachLink: Effect.fn("InboxStore.detachLink")(
      (...args: Parameters<InboxDatabase["detachLink"]>) =>
        Effect.try({
          try: () => database.detachLink(...args),
          catch: (cause) => new InboxStoreError({ operation: "detachLink", path: filePath, cause }),
        }),
    ),
  });
});
