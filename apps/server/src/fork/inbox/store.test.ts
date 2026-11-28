// @effect-diagnostics nodeBuiltinImport:off -- Independent SQLite fixtures verify migrations and handle cleanup.
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi, onTestFinished } from "vite-plus/test";
import * as InboxStore from "./store.ts";

describe("InboxStore acquisition", () => {
  it.effect.each(["future", "migration"])(
    "closes after %s failure and preserves the database",
    (failure) =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inbox-store-")),
        );
        onTestFinished(() => NodeFSP.rm(dir, { recursive: true, force: true }));
        const file = NodePath.join(dir, "inbox.sqlite");
        const fixture = new NodeSqlite.DatabaseSync(file);
        fixture.exec(
          failure === "future"
            ? "PRAGMA user_version = 999"
            : "CREATE TABLE channel_reads (sentinel TEXT); INSERT INTO channel_reads VALUES ('preserved'); PRAGMA user_version = 1",
        );
        fixture.close();
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
          const exit = yield* Effect.exit(
            InboxStore.make(file).pipe(Effect.provide(NodeServices.layer)),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          expect(close).toHaveBeenCalledTimes(1);
        } finally {
          exec.mockRestore();
          close.mockRestore();
          if (acquired?.isOpen) acquired.close();
        }
        const reopened = new NodeSqlite.DatabaseSync(file);
        try {
          expect(reopened.prepare("PRAGMA user_version").get()?.user_version).toBe(
            failure === "future" ? 999 : 1,
          );
          if (failure === "migration") {
            expect(reopened.prepare("SELECT * FROM channel_reads").all()).toEqual([
              { sentinel: "preserved" },
            ]);
            expect(
              reopened.prepare("SELECT name FROM sqlite_master WHERE name = 'reads'").all(),
            ).toEqual([]);
          }
        } finally {
          reopened.close();
        }
      }),
  );
});
