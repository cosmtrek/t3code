// @effect-diagnostics nodeBuiltinImport:off -- Independent SQLite fixtures verify disk compatibility and handle cleanup.
import { ProviderInstanceId } from "@t3tools/contracts";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";
import * as BotStore from "./store.ts";

const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const AT = "2026-11-01T00:00:00.000Z";
const legacy = `
  CREATE TABLE bots (id TEXT PRIMARY KEY, name TEXT NOT NULL, model_selection TEXT NOT NULL,
    created_at TEXT NOT NULL, work_thread_id TEXT, work_project_id TEXT);
  CREATE TABLE chat (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'bot', 'error')), text TEXT NOT NULL,
    created_at TEXT NOT NULL, turn_run_id TEXT);
  CREATE UNIQUE INDEX chat_by_bot ON chat (bot_id, seq);
  CREATE TABLE turns (bot_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL, started_at TEXT NOT NULL);
  PRAGMA user_version = 1;
`;

const filePath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bot-store-" });
  return path.join(dir, "nested", "bots.sqlite");
});

const seedLegacy = (file: string) => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(legacy);
    db.prepare("INSERT INTO bots VALUES (?, ?, ?, ?, ?, ?)").run(
      "old",
      "Old bot",
      JSON.stringify(MODEL),
      AT,
      "work",
      "project",
    );
    db.prepare("INSERT INTO chat VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "old-message",
      "old",
      1,
      "user",
      "Keep this",
      AT,
      "run",
    );
    db.prepare("INSERT INTO turns VALUES (?, ?, ?, ?)").run("old", "run", "work", AT);
  } finally {
    db.close();
  }
};

describe("BotStore", () => {
  it.effect(
    "upgrades a v1 database, writes through the service, and preserves encodings on reopen",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = yield* filePath;
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        seedLegacy(file);
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const store = yield* BotStore.make(file).pipe(Scope.provide(scope));
        expect(yield* store.getBot("old")).toMatchObject({
          id: "old",
          name: "Old bot",
          modelSelection: MODEL,
          workThreadId: "work",
          workProjectId: "project",
          turnsToday: 0,
          paused: false,
        });
        expect(yield* store.recentChat("old", 10)).toEqual([
          {
            id: "old-message",
            botId: "old",
            role: "user",
            text: "Keep this",
            createdAt: AT,
            turnRunId: "run",
          },
        ]);
        expect(yield* store.getTurn("old")).toMatchObject({
          runId: "run",
          answersUser: true,
          said: false,
        });
        expect(yield* store.workingSince("old")).toBe(AT);
        expect(yield* store.unseenCount("old")).toBe(0);
        const settings = {
          ...(yield* store.getBot("old"))!.settings,
          runtimeMode: "full-access" as const,
          turnsPerDay: 42,
        };
        yield* store.setSettings("old", settings);
        const schedule = { type: "daily", time: "09:00" } as const;
        const routine = yield* store.addRoutine("old", {
          title: "Check",
          prompt: "Check CI",
          schedule,
          nextDueAt: AT,
        });
        yield* store.addMemory("old", "Keep releases safe");
        yield* store.endTurn(
          "old",
          "run",
          [
            {
              id: "reply",
              botId: "old",
              role: "bot",
              text: "Done",
              createdAt: AT,
              renders: [{ attachmentId: "page", title: "Report", height: 400 }],
            },
          ],
          AT,
        );
        yield* store.recordSent("old", "chat", "sent", AT);
        yield* store.recordSent("old", "chat", "sent", AT);
        yield* store.markMentionPending("chat", "conversation", AT, "2026-11-02", "2026-10-01");
        yield* store.markMentionPending(
          "chat",
          "conversation",
          "2026-11-03",
          "2026-11-04",
          "ignored",
        );
        yield* Scope.close(scope, Exit.void);
        const closed = yield* Effect.flip(store.listBots());
        expect(closed).toMatchObject({ _tag: "BotStoreError", operation: "listBots", path: file });
        const reopened = yield* BotStore.make(file);
        expect(yield* reopened.getBot("old")).toMatchObject({
          settings: { runtimeMode: "full-access", turnsPerDay: 42 },
        });
        expect(yield* reopened.getTurn("old")).toBeNull();
        expect(yield* reopened.workingSince("old")).toBeNull();
        expect(yield* reopened.listMemory("old")).toEqual([{ id: 1, text: "Keep releases safe" }]);
        expect(yield* reopened.listRoutines("old")).toEqual([
          {
            id: routine,
            botId: "old",
            title: "Check",
            prompt: "Check CI",
            schedule,
            nextDueAt: AT,
          },
        ]);
        expect((yield* reopened.recentChat("old", 10)).at(-1)).toMatchObject({
          renders: [{ attachmentId: "page", title: "Report", height: 400 }],
        });
        expect(yield* reopened.sentByBots("chat", ["sent", "user"])).toEqual(new Set(["sent"]));
        expect(yield* reopened.dueMentions("2026-11-02")).toEqual([
          {
            channelId: "chat",
            conversationId: "conversation",
            handledThrough: "2026-10-01",
            pendingAt: "2026-11-03",
            dueAt: "2026-11-02",
          },
        ]);
        yield* reopened.markMentionHandled("chat", "conversation", "2026-11-03");
        expect(yield* reopened.dueMentions("2026-12-01")).toEqual([]);
        const raw = new NodeSqlite.DatabaseSync(file);
        try {
          expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(11);
          expect(
            raw.prepare("SELECT attachments FROM chat WHERE id = 'reply'").get()?.attachments,
          ).toBeNull();
          expect(
            raw.prepare("SELECT model_selection, settings FROM bots WHERE id = 'old'").get(),
          ).toEqual({
            model_selection: JSON.stringify(MODEL),
            settings: JSON.stringify(settings),
          });
          expect(
            raw.prepare("SELECT schedule FROM routines WHERE id = ?").get(routine)?.schedule,
          ).toBe(JSON.stringify(schedule));
        } finally {
          raw.close();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["future", "migration"])(
    "closes after %s failure without committing migration changes",
    (failure) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = yield* filePath;
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        seedLegacy(file);
        const seed = new NodeSqlite.DatabaseSync(file);
        seed.exec(
          failure === "future"
            ? "PRAGMA user_version = 999"
            : "CREATE TABLE goals (sentinel TEXT); INSERT INTO goals VALUES ('preserved')",
        );
        seed.close();
        const originalExec = NodeSqlite.DatabaseSync.prototype.exec;
        let acquired: NodeSqlite.DatabaseSync | undefined;
        using exec = vi
          .spyOn(NodeSqlite.DatabaseSync.prototype, "exec")
          .mockImplementation(function (this: NodeSqlite.DatabaseSync, sql) {
            acquired = this;
            return originalExec.call(this, sql);
          });
        using close = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "close");
        try {
          const error = yield* Effect.flip(BotStore.make(file));
          expect(error).toMatchObject({ _tag: "BotStoreError", operation: "open", path: file });
          expect(error.cause).toBeInstanceOf(Error);
          expect(close).toHaveBeenCalledTimes(1);
          expect(acquired?.isOpen).toBe(false);
        } finally {
          exec.mockRestore();
          close.mockRestore();
          if (acquired?.isOpen) acquired.close();
        }
        const raw = new NodeSqlite.DatabaseSync(file);
        try {
          expect(raw.prepare("PRAGMA user_version").get()?.user_version).toBe(
            failure === "future" ? 999 : 1,
          );
          expect(raw.prepare("SELECT text FROM chat").get()?.text).toBe("Keep this");
          if (failure === "migration") {
            expect(raw.prepare("SELECT * FROM goals").all()).toEqual([{ sentinel: "preserved" }]);
            expect(
              raw
                .prepare("PRAGMA table_info(bots)")
                .all()
                .map((row) => row.name),
            ).not.toContain("last_turn_day");
            expect(
              raw
                .prepare("PRAGMA table_info(turns)")
                .all()
                .map((row) => row.name),
            ).not.toContain("answers_user");
          }
        } finally {
          raw.close();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back a failed bot transaction and closes the handle with its scope", () =>
    Effect.gen(function* () {
      const file = yield* filePath;
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const store = yield* BotStore.make(file).pipe(Scope.provide(scope));
      yield* store.createBot(
        { id: "first", name: "First", modelSelection: MODEL, createdAt: AT },
        "auto",
        { id: "message", text: "First" },
      );
      const error = yield* Effect.flip(
        store.createBot(
          { id: "second", name: "Second", modelSelection: MODEL, createdAt: AT },
          "auto",
          { id: "message", text: "Duplicate" },
        ),
      );
      expect(error.operation).toBe("createBot");
      expect(yield* store.getBot("second")).toBeNull();
      expect(yield* store.recentChat("second", 10)).toEqual([]);
      yield* store.addMemory("first", "Still usable");
      using close = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "close");
      yield* Scope.close(scope, Exit.void);
      yield* store.close();
      expect(close).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
