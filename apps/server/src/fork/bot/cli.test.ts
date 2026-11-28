// @effect-diagnostics nodeBuiltinImport:off - Runs the written tool against a stub server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";

const sea = vi.hoisted(() => ({ isSea: vi.fn(() => false) }));
vi.mock("node:sea", () => sea);

import * as BotFiles from "./BotFiles.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
const writeCli = (botsDir: string, stateDir: string) =>
  Effect.flatMap(BotFiles.BotFiles, (files) => files.writeCli(botsDir, stateDir));

let root: string;
beforeEach(() => {
  root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3bot-cli-"));
});
afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  sea.isSea.mockReturnValue(false);
});

describe("writeCli", () => {
  it.live("runs the tool as a subcommand of a single executable", () =>
    Effect.gen(function* () {
      sea.isSea.mockReturnValue(true);
      const botsDir = NodePath.join(root, "bots");
      const cliPath = yield* writeCli(botsDir, root);

      expect(NodeFS.readFileSync(cliPath, "utf8")).toContain(
        `exec ${JSON.stringify(process.execPath)} __bot-tool ${JSON.stringify(botsDir)} ${JSON.stringify(root)} "$@"`,
      );
      expect(NodeFS.existsSync(NodePath.join(botsDir, "bin", "t3bot.mjs"))).toBe(false);
    }).pipe(Effect.provide(BotFiles.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

  it.live("runs the written script with Node otherwise", () =>
    Effect.gen(function* () {
      const botsDir = NodePath.join(root, "bots");
      NodeFS.mkdirSync(NodePath.join(botsDir, "b1"), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(botsDir, "b1", "token"), "secret\n");
      const requests: Array<{ auth: string | undefined; body: string }> = [];
      const server = NodeHttp.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          requests.push({ auth: req.headers.authorization, body });
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ output: "done" }));
        });
      });
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      const { port } = server.address() as { port: number };
      NodeFS.writeFileSync(
        NodePath.join(root, "server-runtime.json"),
        JSON.stringify({ origin: `http://127.0.0.1:${port}` }),
      );

      const cliPath = yield* writeCli(botsDir, root);
      expect(NodeFS.readFileSync(cliPath, "utf8")).toContain(
        `ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(
          NodePath.join(botsDir, "bin", "t3bot.mjs"),
        )} "$@"`,
      );
      const output = yield* Effect.promise(() =>
        new Promise<string>((resolve, reject) =>
          NodeChildProcess.execFile(cliPath, ["--bot", "b1", "status"], (error, stdout) =>
            error ? reject(error) : resolve(stdout),
          ),
        ).finally(() => server.close()),
      );

      expect(output).toBe("done\n");
      expect(requests).toEqual([
        {
          auth: "Bearer secret",
          body: JSON.stringify({ bot: "b1", argv: ["status"], stdin: "" }),
        },
      ]);
    }).pipe(Effect.provide(BotFiles.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});
