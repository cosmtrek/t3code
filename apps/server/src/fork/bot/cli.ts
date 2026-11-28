/**
 * The `t3bot` tool a bot runs from its work thread's shell. The server writes it at startup, so it
 * always matches the running server: a shell wrapper around the server's own executable that
 * reads the server's current address on each run (desktop binds a port only known later).
 */
import * as NodeSea from "node:sea";

import { runBotTool } from "./toolCli.ts";

const script = (
  botsDir: string,
  stateDir: string,
) => `// Written by the T3 Code server; do not edit.
import { readFileSync } from "node:fs";

await (${runBotTool.toString()})(${JSON.stringify(botsDir)}, ${JSON.stringify(stateDir)}, process.argv.slice(2), readFileSync);
`;

const header =
  "#!/bin/sh\n# Written by the T3 Code server; runs the bot tool with the server's own executable.\n";

// A single executable runs only its embedded app, so it takes the tool as a subcommand.
const seaWrapper = (botsDir: string, stateDir: string) =>
  `${header}exec ${JSON.stringify(process.execPath)} __bot-tool ${JSON.stringify(botsDir)} ${JSON.stringify(stateDir)} "$@"\n`;

const nodeWrapper = (scriptPath: string) =>
  `${header}ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`;

export function cliFiles(
  botsDir: string,
  stateDir: string,
  scriptPath: string,
): ReadonlyArray<{
  readonly name: string;
  readonly content: string;
  readonly mode?: number;
}> {
  if (NodeSea.isSea())
    return [{ name: "t3bot", content: seaWrapper(botsDir, stateDir), mode: 0o755 }];
  return [
    { name: "t3bot.mjs", content: script(botsDir, stateDir) },
    { name: "t3bot", content: nodeWrapper(scriptPath), mode: 0o755 },
  ];
}
