// @effect-diagnostics nodeBuiltinImport:off - node:sqlite is synchronous and a separate small file keeps fork data out of the main database; times are stored as ISO text.
/**
 * What bots keep that T3 does not: the bots themselves, each one's chat with the user, and the
 * turn it is running. Its own file, like the inbox's, so the main database carries no fork tables.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { ModelSelection, RuntimeMode } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";

import type { PacketSections } from "./packet.ts";

export interface Bot {
  readonly id: string;
  readonly name: string;
  readonly modelSelection: ModelSelection;
  readonly createdAt: string;
  /** Its one work thread, launched on its first turn. */
  readonly workThreadId: string | null;
  readonly workProjectId: string | null;
  /** The local day of its last turn; a new day starts a fresh provider session. */
  readonly lastTurnDay: string | null;
  /** Turns started on `lastTurnDay`. */
  readonly turnsToday: number;
  readonly paused: boolean;
  readonly settings: BotSettings;
}

export type Permission = "allow" | "ask";

/** One connector instance, as this bot may use it. */
export interface ConnectorSettings {
  /** Off: the instance is no command of this bot's. */
  readonly enabled: boolean;
  /** Per write operation; one missing here asks. */
  readonly permissions: Readonly<Record<string, Permission>>;
  /** The connector kind's own settings, decoded by that kind. */
  readonly config: Readonly<Record<string, unknown>>;
}

const CONNECTOR_OFF: ConnectorSettings = { enabled: false, permissions: {}, config: {} };

export interface BotSettings {
  readonly turnsPerDay: number;
  /** Threads it started that may run at once; starting one more asks. */
  readonly maxThreads: number;
  /** Its work thread and the threads it starts; a provider without it gets the next narrower. */
  readonly runtimeMode: RuntimeMode;
  /** What threads it starts run on unless it names another; null is its own model. */
  readonly threadModel: ModelSelection | null;
  /** By connector instance id; one missing here is off. */
  readonly connectors: Readonly<Record<string, ConnectorSettings>>;
}

const DEFAULT_SETTINGS: BotSettings = {
  turnsPerDay: 200,
  maxThreads: 3,
  runtimeMode: "auto",
  threadModel: null,
  connectors: {},
};

interface LegacyChannelSettings {
  readonly send?: Permission;
  readonly mentions?: boolean;
  readonly mentionsSince?: string | null;
}

/** Earlier builds stored one switch and signature for chat, then per-channel settings. */
const toSettings = (value: string): BotSettings => {
  const parsed = JSON.parse(value) as Partial<BotSettings> & {
    readonly channelsEnabled?: boolean;
    readonly signature?: string;
    readonly channels?: Readonly<Record<string, LegacyChannelSettings>>;
  };
  const connectors =
    parsed.connectors ??
    Object.fromEntries(
      Object.entries(parsed.channels ?? {}).map(([channelId, channel]) => {
        const enabled = parsed.channelsEnabled === true;
        const mentions = enabled && channel.mentions === true;
        return [
          channelId,
          {
            enabled,
            permissions: { send: channel.send ?? "ask" },
            config: {
              signature: parsed.signature ?? "",
              mentions,
              mentionsSince: mentions ? (channel.mentionsSince ?? null) : null,
            },
          } satisfies ConnectorSettings,
        ];
      }),
    );
  return {
    turnsPerDay: parsed.turnsPerDay ?? DEFAULT_SETTINGS.turnsPerDay,
    maxThreads: parsed.maxThreads ?? DEFAULT_SETTINGS.maxThreads,
    runtimeMode: parsed.runtimeMode ?? DEFAULT_SETTINGS.runtimeMode,
    threadModel: parsed.threadModel ?? null,
    connectors,
  };
};

export const connectorSettings = (settings: BotSettings, instanceId: string): ConnectorSettings =>
  settings.connectors[instanceId] ?? CONNECTOR_OFF;

export type ChatRole = "user" | "bot" | "error";

export interface ChatMessage {
  readonly id: string;
  readonly botId: string;
  readonly role: ChatRole;
  readonly text: string;
  readonly createdAt: string;
  /** For a user message: the run of the turn that took it; null while it waits. */
  readonly turnRunId: string | null;
  /** Pages its work thread showed with `html_render`, shown above the text. */
  readonly renders?: ReadonlyArray<HtmlRenderReference>;
}

export interface Turn {
  readonly botId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly startedAt: string;
  /** It took a message from the user, so it owes a reply. */
  readonly answersUser: boolean;
  /** It posted to the chat itself with `t3bot say`. */
  readonly said: boolean;
}

export type ItemStatus = "open" | "waiting" | "done";

export interface Item {
  readonly id: number;
  readonly title: string;
  readonly status: ItemStatus;
  /** The next step, or what it waits on. */
  readonly note: string;
  readonly updatedAt: string;
  readonly setAside: boolean;
}

export interface MemoryNote {
  readonly id: number;
  readonly text: string;
}

export type RoutineSchedule =
  | { readonly type: "daily"; readonly time: string; readonly weekdays?: ReadonlyArray<number> }
  | { readonly type: "every"; readonly minutes: number };

export interface Routine {
  readonly id: number;
  readonly botId: string;
  readonly title: string;
  readonly prompt: string;
  readonly schedule: RoutineSchedule;
  readonly nextDueAt: string | null;
}

export type FollowUp = "now" | "attention" | "routine";

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
] as const;
const ENDED_SQL = TERMINAL_RUN_STATUSES.map((status) => `'${status}'`).join(", ");

export interface OwnedThread {
  readonly threadId: string;
  readonly botId: string;
  readonly projectId: string;
  readonly itemId: number | null;
  readonly follow: FollowUp;
  readonly createdAt: string;
  /** The status of its latest run, as last seen. */
  readonly status: string;
  /** `<runId>:<status>` and the request id already reported, so nothing is reported twice. */
  readonly lastRunKey: string | null;
  readonly lastRequestId: string | null;
  /** The user typed in it: theirs until they hand it back. */
  readonly takenOver: boolean;
  readonly handedBackAt: string | null;
}

export type QuestionStatus = "open" | "approved" | "declined" | "expired";

/** An action the bot asked to take; approving runs exactly this tool call. */
export interface Question {
  readonly id: number;
  readonly botId: string;
  readonly text: string;
  readonly argv: ReadonlyArray<string>;
  readonly stdin: string;
  readonly status: QuestionStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly result: string | null;
}

/** Something that happened, waiting for the bot's next turn. */
export interface QueuedEvent {
  readonly id: number;
  readonly botId: string;
  readonly text: string;
  /** Starts a turn on its own; otherwise it waits for one that something else starts. */
  readonly wakes: boolean;
  readonly createdAt: string;
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
  `ALTER TABLE bots ADD COLUMN last_turn_day TEXT;
   ALTER TABLE turns ADD COLUMN answers_user INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE turns ADD COLUMN said INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE goals (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bot_id TEXT NOT NULL,
     title TEXT NOT NULL,
     done INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE items (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bot_id TEXT NOT NULL,
     goal_id INTEGER,
     title TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open', 'waiting', 'done')),
     note TEXT NOT NULL DEFAULT '',
     updated_at TEXT NOT NULL,
     set_aside INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE memory (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bot_id TEXT NOT NULL,
     text TEXT NOT NULL
   );
   CREATE TABLE routines (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bot_id TEXT NOT NULL,
     title TEXT NOT NULL,
     prompt TEXT NOT NULL,
     schedule TEXT NOT NULL,
     next_due_at TEXT
   );
   CREATE TABLE threads (
     thread_id TEXT PRIMARY KEY,
     bot_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     item_id INTEGER,
     follow TEXT NOT NULL CHECK (follow IN ('now', 'attention', 'routine')),
     created_at TEXT NOT NULL
   );
   CREATE TABLE queue (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bot_id TEXT NOT NULL,
     text TEXT NOT NULL,
     wakes INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );`,
  `ALTER TABLE bots ADD COLUMN turns_today INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE bots ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE bots ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE threads ADD COLUMN status TEXT NOT NULL DEFAULT 'running';
   ALTER TABLE threads ADD COLUMN last_run_key TEXT;
   ALTER TABLE threads ADD COLUMN last_request_id TEXT;
   ALTER TABLE threads ADD COLUMN taken_over INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE threads ADD COLUMN handed_back_at TEXT;
   CREATE TABLE questions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     bot_id TEXT NOT NULL,
     text TEXT NOT NULL,
     action TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'declined', 'expired')),
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     result TEXT
   );`,
  `ALTER TABLE bots ADD COLUMN budget_noticed_day TEXT;`,
  `ALTER TABLE bots ADD COLUMN seen_packet TEXT;`,
  `DROP TABLE goals;
   ALTER TABLE items DROP COLUMN goal_id;`,
  `CREATE TABLE mentions (
     channel_id TEXT NOT NULL,
     conversation_id TEXT NOT NULL,
     handled_through TEXT NOT NULL,
     pending_at TEXT,
     due_at TEXT,
     PRIMARY KEY (channel_id, conversation_id)
   );`,
  `ALTER TABLE bots ADD COLUMN seen_seq INTEGER NOT NULL DEFAULT 0;
   UPDATE bots SET seen_seq = (SELECT COALESCE(MAX(seq), 0) FROM chat WHERE chat.bot_id = bots.id);
   CREATE TABLE sent_messages (
     channel_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     bot_id TEXT NOT NULL,
     sent_at TEXT NOT NULL,
     PRIMARY KEY (channel_id, message_id)
   );`,
  `ALTER TABLE chat ADD COLUMN renders TEXT;`,
  `ALTER TABLE bots ADD COLUMN working_since TEXT;
   UPDATE bots SET working_since = (SELECT started_at FROM turns WHERE turns.bot_id = bots.id);`,
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
    lastTurnDay: nullableText(row, "last_turn_day"),
    turnsToday: Number(row.turns_today),
    paused: Number(row.paused) === 1,
    settings: toSettings(text(row, "settings")),
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
    ...(row.renders === null || row.renders === undefined
      ? {}
      : { renders: JSON.parse(text(row, "renders")) as ReadonlyArray<HtmlRenderReference> }),
  };
}

function toTurn(row: Row): Turn {
  return {
    botId: text(row, "bot_id"),
    runId: text(row, "run_id"),
    threadId: text(row, "thread_id"),
    startedAt: text(row, "started_at"),
    answersUser: Number(row.answers_user) === 1,
    said: Number(row.said) === 1,
  };
}

const toItem = (row: Row): Item => ({
  id: Number(row.id),
  title: text(row, "title"),
  status: text(row, "status") as ItemStatus,
  note: text(row, "note"),
  updatedAt: text(row, "updated_at"),
  setAside: Number(row.set_aside) === 1,
});

const toRoutine = (row: Row): Routine => ({
  id: Number(row.id),
  botId: text(row, "bot_id"),
  title: text(row, "title"),
  prompt: text(row, "prompt"),
  schedule: JSON.parse(text(row, "schedule")) as RoutineSchedule,
  nextDueAt: nullableText(row, "next_due_at"),
});

const toThread = (row: Row): OwnedThread => ({
  threadId: text(row, "thread_id"),
  botId: text(row, "bot_id"),
  projectId: text(row, "project_id"),
  itemId: row.item_id === null ? null : Number(row.item_id),
  follow: text(row, "follow") as FollowUp,
  createdAt: text(row, "created_at"),
  status: text(row, "status"),
  lastRunKey: nullableText(row, "last_run_key"),
  lastRequestId: nullableText(row, "last_request_id"),
  takenOver: Number(row.taken_over) === 1,
  handedBackAt: nullableText(row, "handed_back_at"),
});

const toQuestion = (row: Row): Question => {
  const action = JSON.parse(text(row, "action")) as { argv: string[]; stdin: string };
  return {
    id: Number(row.id),
    botId: text(row, "bot_id"),
    text: text(row, "text"),
    argv: action.argv,
    stdin: action.stdin,
    status: text(row, "status") as QuestionStatus,
    createdAt: text(row, "created_at"),
    expiresAt: text(row, "expires_at"),
    result: nullableText(row, "result"),
  };
};

const toQueued = (row: Row): QueuedEvent => ({
  id: Number(row.id),
  botId: text(row, "bot_id"),
  text: text(row, "text"),
  wakes: Number(row.wakes) === 1,
  createdAt: text(row, "created_at"),
});

export class BotStore {
  /** Connectors keep their own tables in this file and query them through it. */
  readonly db: NodeSqlite.DatabaseSync;

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

  createBot(
    bot: Pick<Bot, "id" | "name" | "modelSelection" | "createdAt">,
    runtimeMode: RuntimeMode,
    firstMessage?: Pick<ChatMessage, "id" | "text">,
  ) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO bots (id, name, model_selection, created_at, settings) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          bot.id,
          bot.name,
          JSON.stringify(bot.modelSelection),
          bot.createdAt,
          JSON.stringify({ runtimeMode }),
        );
      if (firstMessage !== undefined) {
        this.addChat({ ...firstMessage, botId: bot.id, role: "user", createdAt: bot.createdAt });
      }
    });
  }

  deleteBot(id: string) {
    this.transaction(() => {
      for (const table of [
        "chat",
        "turns",
        "items",
        "memory",
        "routines",
        "threads",
        "queue",
        "questions",
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE bot_id = ?`).run(id);
      }
      this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
    });
  }

  /** Counts a turn on `day`, starting the count over on a new day. */
  countTurn(id: string, day: string) {
    this.db
      .prepare(
        "UPDATE bots SET turns_today = CASE WHEN last_turn_day = ? THEN turns_today + 1 ELSE 1 END, last_turn_day = ? WHERE id = ?",
      )
      .run(day, day, id);
  }

  /** Claims the day's one over-budget notice; false when it already went out that day. */
  noteBudgetSpent(id: string, day: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE bots SET budget_noticed_day = ? WHERE id = ? AND budget_noticed_day IS NOT ?",
          )
          .run(day, id, day).changes,
      ) > 0
    );
  }

  setProfile(id: string, name: string, modelSelection: ModelSelection) {
    this.db
      .prepare("UPDATE bots SET name = ?, model_selection = ? WHERE id = ?")
      .run(name, JSON.stringify(modelSelection), id);
  }

  /** The model the work thread's provider session last ran on; null before its first turn. */
  seenModel(id: string): ModelSelection | null {
    const row = this.db.prepare("SELECT seen_packet FROM bots WHERE id = ?").get(id);
    const stored = row === undefined ? null : nullableText(row, "seen_packet");
    if (stored === null) return null;
    return JSON.parse((JSON.parse(stored) as { model: string }).model) as ModelSelection;
  }

  setPaused(id: string, paused: boolean) {
    this.db.prepare("UPDATE bots SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
  }

  /** A new budget may run out again the same day, so its notice can go out again. */
  setSettings(id: string, settings: BotSettings) {
    this.db
      .prepare("UPDATE bots SET settings = ?, budget_noticed_day = NULL WHERE id = ?")
      .run(JSON.stringify(settings), id);
  }

  /**
   * The packet sections the work thread's provider session has seen; null when none were stored
   * or they went to another model, which may mean another session.
   */
  seenPacket(id: string, model: ModelSelection): PacketSections | null {
    const row = this.db.prepare("SELECT seen_packet FROM bots WHERE id = ?").get(id);
    const stored = row === undefined ? null : nullableText(row, "seen_packet");
    if (stored === null) return null;
    const seen = JSON.parse(stored) as { model: string; sections: PacketSections };
    return seen.model === JSON.stringify(model) ? seen.sections : null;
  }

  /** Null when the session may not hold them, so the next turn sends everything again. */
  setSeenPacket(id: string, seen: { model: ModelSelection; sections: PacketSections } | null) {
    this.db
      .prepare("UPDATE bots SET seen_packet = ? WHERE id = ?")
      .run(
        seen === null
          ? null
          : JSON.stringify({ model: JSON.stringify(seen.model), sections: seen.sections }),
        id,
      );
  }

  setWorkThread(id: string, threadId: string, projectId: string) {
    this.db
      .prepare("UPDATE bots SET work_thread_id = ?, work_project_id = ? WHERE id = ?")
      .run(threadId, projectId, id);
  }

  addChat(message: Omit<ChatMessage, "turnRunId">) {
    this.db
      .prepare(
        `INSERT INTO chat (id, bot_id, seq, role, text, created_at, renders)
         VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM chat WHERE bot_id = ?), ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.botId,
        message.botId,
        message.role,
        message.text,
        message.createdAt,
        message.renders === undefined || message.renders.length === 0
          ? null
          : JSON.stringify(message.renders),
      );
  }

  hasChat(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM chat WHERE id = ?").get(id) !== undefined;
  }

  /** The pages already posted since `since`, by attachment id. */
  postedRenderIds(botId: string, since: string): ReadonlySet<string> {
    const rows = this.db
      .prepare(
        "SELECT renders FROM chat WHERE bot_id = ? AND created_at >= ? AND renders IS NOT NULL",
      )
      .all(botId, since) as Row[];
    return new Set(
      rows.flatMap((row) =>
        (JSON.parse(text(row, "renders")) as ReadonlyArray<HtmlRenderReference>).map(
          (render) => render.attachmentId,
        ),
      ),
    );
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

  /** What the bot posted since the user last looked at its chat. */
  unseenCount(botId: string): number {
    return Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM chat WHERE bot_id = ? AND role != 'user' AND seq > (SELECT seen_seq FROM bots WHERE id = ?)",
          )
          .get(botId, botId) as Row
      ).n,
    );
  }

  /** False when nothing new was there to see. */
  markSeen(botId: string): boolean {
    return (
      Number(
        this.db
          .prepare(
            `UPDATE bots SET seen_seq = (SELECT COALESCE(MAX(seq), 0) FROM chat WHERE bot_id = ?)
             WHERE id = ? AND seen_seq < (SELECT COALESCE(MAX(seq), 0) FROM chat WHERE bot_id = ?)`,
          )
          .run(botId, botId, botId).changes,
      ) > 0
    );
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

  /** Records the running turn, hands it the messages it answers, and takes the queue. */
  startTurn(
    turn: Omit<Turn, "said" | "answersUser">,
    messageIds: ReadonlyArray<string>,
    eventIds: ReadonlyArray<number>,
  ) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO turns (bot_id, run_id, thread_id, started_at, answers_user) VALUES (?, ?, ?, ?, ?)",
        )
        .run(turn.botId, turn.runId, turn.threadId, turn.startedAt, messageIds.length > 0 ? 1 : 0);
      this.markAnswered(turn.botId, turn.runId, messageIds);
      const take = this.db.prepare("DELETE FROM queue WHERE id = ? AND bot_id = ?");
      for (const id of eventIds) take.run(id, turn.botId);
      this.syncWorking(turn.botId, turn.startedAt);
    });
  }

  /** Gives messages to a running turn, as when one is steered into it. */
  markAnswered(botId: string, runId: string, messageIds: ReadonlyArray<string>) {
    const mark = this.db.prepare("UPDATE chat SET turn_run_id = ? WHERE id = ? AND bot_id = ?");
    for (const id of messageIds) mark.run(runId, id, botId);
    if (messageIds.length > 0) {
      this.db
        .prepare("UPDATE turns SET answers_user = 1 WHERE bot_id = ? AND run_id = ?")
        .run(botId, runId);
    }
  }

  markSaid(botId: string) {
    this.db.prepare("UPDATE turns SET said = 1 WHERE bot_id = ?").run(botId);
  }

  /** Ends the turn and posts what it said, together, so a restart never posts it twice. */
  endTurn(
    botId: string,
    runId: string,
    replies: ReadonlyArray<Omit<ChatMessage, "turnRunId">>,
    at: string,
  ) {
    this.transaction(() => {
      const ended = this.db
        .prepare("DELETE FROM turns WHERE bot_id = ? AND run_id = ?")
        .run(botId, runId);
      if (Number(ended.changes) > 0) for (const reply of replies) this.addChat(reply);
      this.syncWorking(botId, at);
    });
  }

  /**
   * When the bot started working, or null when it is not: its own turn runs, or a thread it
   * follows `now` does. One span from the user's ask to the answer, across hand-offs.
   */
  workingSince(botId: string): string | null {
    const row = this.db.prepare("SELECT working_since FROM bots WHERE id = ?").get(botId) as
      | Row
      | undefined;
    return row === undefined ? null : nullableText(row, "working_since");
  }

  private syncWorking(botId: string, at: string) {
    this.db
      .prepare(
        `UPDATE bots SET working_since = CASE
           WHEN EXISTS (SELECT 1 FROM turns WHERE bot_id = ?1)
             OR EXISTS (SELECT 1 FROM threads WHERE bot_id = ?1 AND follow = 'now'
                          AND taken_over = 0 AND status NOT IN (${ENDED_SQL}))
           THEN COALESCE(working_since, ?2) END
         WHERE id = ?1`,
      )
      .run(botId, at);
  }

  // Notebook

  listItems(botId: string): ReadonlyArray<Item> {
    return (
      this.db.prepare("SELECT * FROM items WHERE bot_id = ? ORDER BY id").all(botId) as Row[]
    ).map(toItem);
  }

  addItem(
    botId: string,
    item: { readonly title: string; readonly note: string },
    at: string,
  ): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO items (bot_id, title, status, note, updated_at) VALUES (?, ?, 'open', ?, ?)",
        )
        .run(botId, item.title, item.note, at).lastInsertRowid,
    );
  }

  /** Any change, or an event on one of its threads, touches it and brings it back from aside. */
  updateItem(
    botId: string,
    id: number,
    patch: Partial<Pick<Item, "title" | "status" | "note">>,
    at: string,
  ): boolean {
    const item = this.listItems(botId).find((candidate) => candidate.id === id);
    if (!item) return false;
    this.db
      .prepare(
        "UPDATE items SET title = ?, status = ?, note = ?, updated_at = ?, set_aside = 0 WHERE id = ? AND bot_id = ?",
      )
      .run(
        patch.title ?? item.title,
        patch.status ?? item.status,
        patch.note ?? item.note,
        at,
        id,
        botId,
      );
    return true;
  }

  /** Sets aside open items untouched since `before`; returns the bots whose items moved. */
  setAsideStale(before: string): ReadonlyArray<string> {
    const rows = this.db
      .prepare(
        "UPDATE items SET set_aside = 1 WHERE status != 'done' AND set_aside = 0 AND updated_at < ? RETURNING bot_id",
      )
      .all(before) as Row[];
    return [...new Set(rows.map((row) => text(row, "bot_id")))];
  }

  listMemory(botId: string): ReadonlyArray<MemoryNote> {
    return (
      this.db.prepare("SELECT * FROM memory WHERE bot_id = ? ORDER BY id").all(botId) as Row[]
    ).map((row) => ({ id: Number(row.id), text: text(row, "text") }));
  }

  addMemory(botId: string, value: string): number {
    return Number(
      this.db.prepare("INSERT INTO memory (bot_id, text) VALUES (?, ?)").run(botId, value)
        .lastInsertRowid,
    );
  }

  editMemory(botId: string, id: number, value: string): boolean {
    return (
      Number(
        this.db
          .prepare("UPDATE memory SET text = ? WHERE id = ? AND bot_id = ?")
          .run(value, id, botId).changes,
      ) > 0
    );
  }

  removeMemory(botId: string, id: number): boolean {
    return (
      Number(
        this.db.prepare("DELETE FROM memory WHERE id = ? AND bot_id = ?").run(id, botId).changes,
      ) > 0
    );
  }

  // Routines

  listRoutines(botId?: string): ReadonlyArray<Routine> {
    return (
      (botId === undefined
        ? this.db.prepare("SELECT * FROM routines ORDER BY id").all()
        : this.db
            .prepare("SELECT * FROM routines WHERE bot_id = ? ORDER BY id")
            .all(botId)) as Row[]
    ).map(toRoutine);
  }

  addRoutine(
    botId: string,
    routine: Pick<Routine, "title" | "prompt" | "schedule" | "nextDueAt">,
  ): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO routines (bot_id, title, prompt, schedule, next_due_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          botId,
          routine.title,
          routine.prompt,
          JSON.stringify(routine.schedule),
          routine.nextDueAt,
        ).lastInsertRowid,
    );
  }

  updateRoutine(
    botId: string,
    id: number,
    patch: Partial<Pick<Routine, "title" | "prompt" | "schedule" | "nextDueAt">>,
  ): boolean {
    const routine = this.listRoutines(botId).find((candidate) => candidate.id === id);
    if (!routine) return false;
    this.db
      .prepare(
        "UPDATE routines SET title = ?, prompt = ?, schedule = ?, next_due_at = ? WHERE id = ? AND bot_id = ?",
      )
      .run(
        patch.title ?? routine.title,
        patch.prompt ?? routine.prompt,
        JSON.stringify(patch.schedule ?? routine.schedule),
        patch.nextDueAt === undefined ? routine.nextDueAt : patch.nextDueAt,
        id,
        botId,
      );
    return true;
  }

  removeRoutine(botId: string, id: number): boolean {
    return (
      Number(
        this.db.prepare("DELETE FROM routines WHERE id = ? AND bot_id = ?").run(id, botId).changes,
      ) > 0
    );
  }

  // Threads a bot owns

  listThreads(botId?: string): ReadonlyArray<OwnedThread> {
    return (
      (botId === undefined
        ? this.db.prepare("SELECT * FROM threads ORDER BY created_at").all()
        : this.db
            .prepare("SELECT * FROM threads WHERE bot_id = ? ORDER BY created_at")
            .all(botId)) as Row[]
    ).map(toThread);
  }

  getThread(threadId: string): OwnedThread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE thread_id = ?").get(threadId) as
      | Row
      | undefined;
    return row ? toThread(row) : null;
  }

  updateThread(
    threadId: string,
    patch: Partial<
      Pick<OwnedThread, "status" | "lastRunKey" | "lastRequestId" | "takenOver" | "handedBackAt">
    >,
    at: string,
  ) {
    const thread = this.getThread(threadId);
    if (thread === null) return;
    const next = { ...thread, ...patch };
    this.db
      .prepare(
        "UPDATE threads SET status = ?, last_run_key = ?, last_request_id = ?, taken_over = ?, handed_back_at = ? WHERE thread_id = ?",
      )
      .run(
        next.status,
        next.lastRunKey,
        next.lastRequestId,
        next.takenOver ? 1 : 0,
        next.handedBackAt,
        threadId,
      );
    this.syncWorking(thread.botId, at);
  }

  addThread(
    thread: Pick<
      OwnedThread,
      "threadId" | "botId" | "projectId" | "itemId" | "follow" | "createdAt"
    >,
  ) {
    this.db
      .prepare(
        "INSERT INTO threads (thread_id, bot_id, project_id, item_id, follow, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        thread.threadId,
        thread.botId,
        thread.projectId,
        thread.itemId,
        thread.follow,
        thread.createdAt,
      );
    this.syncWorking(thread.botId, thread.createdAt);
  }

  removeThread(threadId: string, at: string) {
    const thread = this.getThread(threadId);
    this.db.prepare("DELETE FROM threads WHERE thread_id = ?").run(threadId);
    if (thread !== null) this.syncWorking(thread.botId, at);
  }

  // Queue

  enqueue(botId: string, value: string, wakes: boolean, at: string) {
    this.db
      .prepare("INSERT INTO queue (bot_id, text, wakes, created_at) VALUES (?, ?, ?, ?)")
      .run(botId, value, wakes ? 1 : 0, at);
  }

  queued(botId: string): ReadonlyArray<QueuedEvent> {
    return (
      this.db.prepare("SELECT * FROM queue WHERE bot_id = ? ORDER BY id").all(botId) as Row[]
    ).map(toQueued);
  }

  // Questions

  addQuestion(
    question: Pick<Question, "botId" | "text" | "argv" | "stdin" | "createdAt" | "expiresAt">,
  ): number {
    return Number(
      this.db
        .prepare(
          "INSERT INTO questions (bot_id, text, action, status, created_at, expires_at) VALUES (?, ?, ?, 'open', ?, ?)",
        )
        .run(
          question.botId,
          question.text,
          JSON.stringify({ argv: question.argv, stdin: question.stdin }),
          question.createdAt,
          question.expiresAt,
        ).lastInsertRowid,
    );
  }

  openQuestions(botId: string): ReadonlyArray<Question> {
    return (
      this.db
        .prepare("SELECT * FROM questions WHERE bot_id = ? AND status = 'open' ORDER BY id")
        .all(botId) as Row[]
    ).map(toQuestion);
  }

  /** Claims an open, unexpired question once; null when it was answered or has expired. */
  answerQuestion(botId: string, id: number, status: "approved" | "declined", at: string) {
    const claimed = this.db
      .prepare(
        "UPDATE questions SET status = ? WHERE id = ? AND bot_id = ? AND status = 'open' AND expires_at > ?",
      )
      .run(status, id, botId, at);
    if (Number(claimed.changes) === 0) return null;
    const row = this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row;
    return toQuestion(row);
  }

  setQuestionResult(id: number, result: string) {
    this.db.prepare("UPDATE questions SET result = ? WHERE id = ?").run(result, id);
  }

  /** Expires open questions past their time and returns them. */
  expireQuestions(at: string): ReadonlyArray<Question> {
    const due = (
      this.db
        .prepare("SELECT * FROM questions WHERE status = 'open' AND expires_at <= ?")
        .all(at) as Row[]
    ).map(toQuestion);
    const expire = this.db.prepare("UPDATE questions SET status = 'expired' WHERE id = ?");
    for (const question of due) expire.run(question.id);
    return due;
  }
}
