// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous; a separate small file keeps fork data out of the main database.
/**
 * What bots keep that T3 does not: the bots themselves, each one's chat with the user, and the
 * turn it is running. Its own file, like the inbox's, so the main database carries no fork tables.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { ModelSelection } from "@t3tools/contracts";

export interface Bot {
  readonly id: string;
  readonly name: string;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
  /** Its one work thread, launched on its first turn. */
  readonly workThreadId: string | null;
  readonly workProjectId: string | null;
}

export type ChatRole = "user" | "bot" | "error";

export interface ChatMessage {
  readonly id: string;
  readonly botId: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly createdAt: string;
  /** For a user message: the run of the turn that took it; null while it waits. */
  readonly turnRunId: string | null;
}

export interface Turn {
  readonly botId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly startedAt: string;
}

/** Forward-only; each entry moves `user_version` up by one. */
const MIGRATIONS: ReadonlyArray<string> = [
  `CREATE TABLE bots (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     model_selection TEXT NOT NULL,
     created_at TEXT NOT NULL,
     work_thread_id TEXT,
     work_project_id TEXT
   );
   CREATE TABLE chat (
     id TEXT PRIMARY KEY,
     bot_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('user', 'bot', 'error')),
     text TEXT NOT NULL,
     created_at TEXT NOT NULL,
     turn_run_id TEXT
   );
   CREATE UNIQUE INDEX chat_by_bot ON chat (bot_id, seq);
   CREATE TABLE turns (
     bot_id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     thread_id TEXT NOT NULL,
     started_at TEXT NOT NULL
   );`,
];

type Row = Record<string, NodeSqlite.SQLOutputValue>;

const text = (row: Row, key: string) => String(row[key]);
const nullableText = (row: Row, key: string) => (row[key] === null ? null : String(row[key]));

function toBot(row: Row): Bot {
  return {
    id: text(row, "id"),
    name: text(row, "name"),
    modelSelection: JSON.parse(text(row, "model_selection")) as ModelSelection,
    createdAt: text(row, "created_at"),
    workThreadId: nullableText(row, "work_thread_id"),
    workProjectId: nullableText(row, "work_project_id"),
  };
}

function toChat(row: Row): ChatMessage {
  return {
    id: text(row, "id"),
    botId: text(row, "bot_id"),
    role: text(row, "role") as ChatRole,
    text: text(row, "text"),
    createdAt: text(row, "created_at"),
    turnRunId: nullableText(row, "turn_run_id"),
  };
}

function toTurn(row: Row): Turn {
  return {
    botId: text(row, "bot_id"),
    runId: text(row, "run_id"),
    threadId: text(row, "thread_id"),
    startedAt: text(row, "started_at"),
  };
}

export class BotStore {
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
        `bots.sqlite is at version ${version}, newer than this build knows (${MIGRATIONS.length}).`,
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

  close() {
    this.db.close();
  }

  listBots(): ReadonlyArray<Bot> {
    return (this.db.prepare("SELECT * FROM bots ORDER BY created_at").all() as Row[]).map(toBot);
  }

  getBot(id: string): Bot | null {
    const row = this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as Row | undefined;
    return row ? toBot(row) : null;
  }

  createBot(bot: Pick<Bot, "id" | "name" | "modelSelection" | "createdAt">) {
    this.db
      .prepare("INSERT INTO bots (id, name, model_selection, created_at) VALUES (?, ?, ?, ?)")
      .run(bot.id, bot.name, JSON.stringify(bot.modelSelection), bot.createdAt);
  }

  deleteBot(id: string) {
    this.transaction(() => {
      this.db.prepare("DELETE FROM chat WHERE bot_id = ?").run(id);
      this.db.prepare("DELETE FROM turns WHERE bot_id = ?").run(id);
      this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
    });
  }

  setWorkThread(id: string, threadId: string, projectId: string) {
    this.db
      .prepare("UPDATE bots SET work_thread_id = ?, work_project_id = ? WHERE id = ?")
      .run(threadId, projectId, id);
  }

  addChat(message: Omit<ChatMessage, "turnRunId">) {
    this.db
      .prepare(
        `INSERT INTO chat (id, bot_id, seq, role, text, created_at)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat WHERE bot_id = ?), ?, ?, ?)`,
      )
      .run(message.id, message.botId, message.botId, message.role, message.text, message.createdAt);
  }

  /** The latest `limit` messages, oldest first. */
  recentChat(botId: string, limit: number): ReadonlyArray<ChatMessage> {
    return (
      this.db
        .prepare("SELECT * FROM chat WHERE bot_id = ? ORDER BY seq DESC LIMIT ?")
        .all(botId, limit) as Row[]
    )
      .map(toChat)
      .toReversed();
  }

  /** User messages no turn has taken yet, oldest first. */
  waitingMessages(botId: string): ReadonlyArray<ChatMessage> {
    return (
      this.db
        .prepare(
          "SELECT * FROM chat WHERE bot_id = ? AND role = 'user' AND turn_run_id IS NULL ORDER BY seq",
        )
        .all(botId) as Row[]
    ).map(toChat);
  }

  getTurn(botId: string): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE bot_id = ?").get(botId) as
      | Row
      | undefined;
    return row ? toTurn(row) : null;
  }

  listTurns(): ReadonlyArray<Turn> {
    return (this.db.prepare("SELECT * FROM turns").all() as Row[]).map(toTurn);
  }

  /** Records the running turn and hands it the messages it answers. */
  startTurn(turn: Turn, messageIds: ReadonlyArray<string>) {
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO turns (bot_id, run_id, thread_id, started_at) VALUES (?, ?, ?, ?)")
        .run(turn.botId, turn.runId, turn.threadId, turn.startedAt);
      const mark = this.db.prepare("UPDATE chat SET turn_run_id = ? WHERE id = ? AND bot_id = ?");
      for (const id of messageIds) mark.run(turn.runId, id, turn.botId);
    });
  }

  /** Ends the turn and posts what it said, together, so a restart never posts it twice. */
  endTurn(botId: string, runId: string, reply: Omit<ChatMessage, "turnRunId"> | null) {
    this.transaction(() => {
      const ended = this.db
        .prepare("DELETE FROM turns WHERE bot_id = ? AND run_id = ?")
        .run(botId, runId);
      if (Number(ended.changes) > 0 && reply !== null) this.addChat(reply);
    });
  }
}
