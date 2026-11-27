#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { buildPacket } from "../../apps/server/src/fork/bot/packet.ts";
import { HELP } from "../../apps/server/src/fork/bot/tools.ts";
import { botNotebookCases } from "./cases.ts";
import { passes, placesWritten } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    samples: { type: "string", default: "3" },
    case: { type: "string", multiple: true },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model haiku] [--samples 3].");
const samples = Number(values.samples);
const cases = botNotebookCases.filter(
  (fixture) => !values.case?.length || values.case.includes(fixture.id),
);

const ROLE = [
  "You run day-to-day ops for this machine: health checks, services, disk, and upgrades.",
  "",
  "## Rules",
  "- Ask the user before restarting core services or changing firewall or SSH settings.",
].join("\n");

const INSTRUCTION = [
  "",
  "(Eval harness: you cannot run commands here. First output every shell command you would run",
  "this turn, one per line, exactly as you would type it, including file writes. Then a line",
  "with only ---, then your final message to the user.)",
].join("\n");

function prompt(message: string): string {
  const now = new Date("2026-11-27T09:00:00Z");
  const packet = buildPacket({
    name: "Ops",
    role: ROLE,
    tool: "t3bot",
    notebook: {
      items: [],
      threads: [],
      routines: [],
      memory: [{ id: 1, text: "The user's timezone is UTC+8." }],
    },
    notesPath: "/home/user/.bot/notes",
    notes: [],
    skillsPath: "/home/user/.bot/skills",
    sharedSkillsPath: "/home/user/.bots/skills",
    skills: [],
    questions: [],
    recentChat: [],
    newMessages: [
      {
        id: "m1",
        botId: "b",
        role: "user",
        text: message,
        createdAt: now.toISOString(),
        turnRunId: null,
      },
    ],
    events: [],
    now,
    firstTurnToday: false,
    connectors: [],
    threadModel: "--provider codex --model gpt-5",
  });
  const help = HELP.replace("{connectors}", "").replace("{threadModel}", "its default model");
  return `${packet.text}\n\nOutput of \`t3bot help\`:\n${help}\n${INSTRUCTION}`;
}

const rows = [];
for (const fixture of cases) {
  let passed = 0;
  for (let sample = 0; sample < samples; sample++) {
    const output = NodeChildProcess.execFileSync(
      "claude",
      [
        "-p",
        "--model",
        values.model,
        "--tools",
        "",
        "--no-session-persistence",
        "--setting-sources",
        "",
      ],
      { input: prompt(fixture.message), encoding: "utf8", cwd: NodePath.sep, timeout: 180_000 },
    );
    const commands = output.split(/^---$/m)[0] ?? "";
    const ok = passes(fixture.expect, commands);
    if (ok) passed++;
    rows.push({
      id: fixture.id,
      sample,
      expect: fixture.expect,
      wrote: [...placesWritten(commands)],
      pass: ok,
      output,
    });
  }
  console.log(`${passed >= samples / 2 ? "PASS" : "FAIL"} ${fixture.id}: ${passed}/${samples}`);
}

NodeFS.mkdirSync(values.out, { recursive: true });
NodeFS.writeFileSync(NodePath.join(values.out, "results.json"), JSON.stringify(rows, null, 2));
