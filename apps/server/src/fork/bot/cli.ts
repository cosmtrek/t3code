// @effect-diagnostics nodeBuiltinImport:off - Writes the tool script next to the bots' state.
/**
 * The `t3bot` tool a bot runs from its work thread's shell. The server writes it at startup, so it
 * always matches the running server: a shell wrapper around the server's own Node, and a script
 * that reads the server's current address on each run (desktop binds a port only known later).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const script = (
  botsDir: string,
  stateDir: string,
) => `// Written by the T3 Code server; do not edit.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BOTS_DIR = ${JSON.stringify(botsDir)};
const STATE_DIR = ${JSON.stringify(stateDir)};
const args = process.argv.slice(2);
let bot = null;
if (args[0] === "--bot") {
  bot = args[1];
  args.splice(0, 2);
} else if (args[0]?.startsWith("--bot=")) {
  bot = args[0].slice("--bot=".length);
  args.splice(0, 1);
}
const fail = (message) => {
  process.stderr.write(\`t3bot: \${message}\\n\`);
  process.exit(1);
};
if (!bot) fail("missing --bot <id>");
let token;
let origin;
try {
  token = readFileSync(join(BOTS_DIR, bot, "token"), "utf8").trim();
  origin = JSON.parse(readFileSync(join(STATE_DIR, "server-runtime.json"), "utf8")).origin;
} catch (error) {
  fail(\`cannot reach the T3 server: \${error.message}\`);
}
const stdin = args.includes("-") && !process.stdin.isTTY ? readFileSync(0, "utf8") : "";
let response;
try {
  response = await fetch(new URL("/api/fork/bots/tool", origin), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: \`Bearer \${token}\` },
    body: JSON.stringify({ bot, argv: args, stdin }),
  });
} catch (error) {
  fail(\`cannot reach the T3 server: \${error.message}\`);
}
const body = await response.json().catch(() => ({ message: \`the server answered \${response.status}\` }));
if (!response.ok) fail(body.message ?? \`the server answered \${response.status}\`);
const output = String(body.output ?? "");
process.stdout.write(output.endsWith("\\n") ? output : \`\${output}\\n\`);
`;

const wrapper = (scriptPath: string) => `#!/bin/sh
# Written by the T3 Code server; runs the bot tool with the server's own Node.
ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"
`;

/** Writes `bin/t3bot` and returns its path. */
export async function writeCli(botsDir: string, stateDir: string): Promise<string> {
  const binDir = NodePath.join(botsDir, "bin");
  const scriptPath = NodePath.join(binDir, "t3bot.mjs");
  const cliPath = NodePath.join(binDir, "t3bot");
  await NodeFSP.mkdir(binDir, { recursive: true });
  await NodeFSP.writeFile(scriptPath, script(botsDir, stateDir));
  await NodeFSP.writeFile(cliPath, wrapper(scriptPath), { mode: 0o755 });
  return cliPath;
}
