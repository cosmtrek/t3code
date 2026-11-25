// @effect-diagnostics globalDate:off - Packets render plain Dates; the inputs are fixed instants.
import { describe, expect, it } from "@effect/vitest";

import { buildPacket, type PacketInput } from "./packet.ts";
import type { ChatMessage, Item } from "./store.ts";

const NOW = new Date("2026-11-23T09:00:00Z");
const DAY = 86_400_000;

const item = (id: number, daysAgo: number, patch: Partial<Item> = {}): Item => ({
  id,
  title: `Item ${id}`,
  status: "open",
  note: "",
  updatedAt: new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  setAside: false,
  ...patch,
});

const chat = (index: number, text = `message ${index}`): ChatMessage => ({
  id: `m${index}`,
  botId: "bot",
  role: index % 2 === 0 ? "user" : "bot",
  text,
  createdAt: `t${index}`,
  turnRunId: "run",
});

const input = (patch: Partial<PacketInput>): PacketInput => ({
  name: "Bot",
  role: "",
  tool: "t3bot --bot bot",
  notebook: { items: [], threads: [], routines: [], memory: [] },
  notesPath: "/notes",
  notes: [],
  skillsPath: "/skills",
  sharedSkillsPath: "/shared",
  skills: [],
  questions: [],
  recentChat: [],
  newMessages: [],
  events: [],
  now: NOW,
  firstTurnToday: false,
  channels: [],
  ...patch,
});

describe("wake packet", () => {
  it("lists items untouched for a week only on the day's first turn", () => {
    const items = [
      item(1, 8),
      item(2, 2),
      item(3, 9, { status: "done" }),
      item(4, 10, { setAside: true }),
    ];
    const notebook = { items, threads: [], routines: [], memory: [] };
    const first = buildPacket(input({ notebook, firstTurnToday: true })).text;
    const stale = first.split("Stale")[1]!;
    expect(stale).toContain("#1 Item 1");
    expect(stale).not.toContain("#2");
    expect(stale).not.toContain("#3");
    expect(stale).not.toContain("#4");
    expect(buildPacket(input({ notebook })).text).not.toContain("Stale");
  });

  it("caps recent chat, long messages, and the event list", () => {
    const { text: packet } = buildPacket(
      input({
        recentChat: Array.from({ length: 15 }, (_, index) => chat(index)),
        newMessages: [chat(100, "x".repeat(3_000))],
        events: Array.from({ length: 35 }, (_, index) => `event ${index}`),
      }),
    );
    expect(packet).not.toContain("message 4\n");
    expect(packet).toContain("message 5");
    expect(packet).toContain(`${"x".repeat(2_000)}… (cut)`);
    expect(packet).toContain("- event 29");
    expect(packet).not.toContain("- event 30");
    expect(packet).toContain("- and 5 more");
  });

  it("sends a continuing session only what changed and none of the chat it holds", () => {
    const memory = [{ id: 1, botId: "bot", text: "Fact" }];
    const notebook = { items: [], threads: [], routines: [], memory };
    const first = buildPacket(input({ role: "Watch CI.", notebook, recentChat: [chat(1)] }));
    expect(first.text).toContain("Watch CI.");
    expect(first.text).toContain("message 1");

    const next = buildPacket(
      input({
        role: "Watch CI.",
        notebook: { ...notebook, memory: [...memory, { id: 2, botId: "bot", text: "New fact" }] },
        recentChat: [chat(1), chat(2)],
        questions: [{ id: 3, text: "Delete it?" }],
        newMessages: [chat(4, "Go on")],
      }),
      first.sections,
    ).text;
    expect(next).not.toContain("Watch CI.");
    expect(next).not.toContain("message 1");
    expect(next).not.toContain("Skills:");
    expect(next).toContain("2: New fact");
    expect(next).toContain("question 3: Delete it?");
    expect(next).toContain("Go on");
  });
});
