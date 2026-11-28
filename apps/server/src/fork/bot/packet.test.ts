// @effect-diagnostics globalDate:off - Packets render plain Dates; the inputs are fixed instants.
import { describe, expect, it } from "@effect/vitest";

import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";

import { buildPacket, chatPreview, type PacketInput } from "./packet.ts";
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
  attachmentsDir: "/attachments",
  events: [],
  now: NOW,
  firstTurnToday: false,
  connectors: [],
  threadModel: "--provider claudeAgent --model claude-haiku-5-5",
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

  it("expands citations as a thread turn does, cutting only the user's words", () => {
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("bot"),
      messageId: MessageId.make("m1"),
      text: "Pick A.",
      start: 0,
      end: 7,
      prefix: "",
      suffix: " It is faster.",
      comment: "Why not B?",
    });
    const text = buildPacket(
      input({ newMessages: [chat(2, `${citation} ${"x".repeat(3_000)}`)] }),
    ).text;
    const words = `[assistant-quote-1] ${"x".repeat(3_000)}`.slice(0, 2_000);
    expect(text).toContain(`${words}… (cut)\n\n<assistant_citations>`);
    expect(text).toContain('"text": "Pick A."');
    expect(text).toContain('"comment": "Why not B?"');
  });

  it("previews a message with its citations as quoted words, spaced from the text", () => {
    const cite = (text: string, comment?: string) =>
      serializeAssistantCitation({
        version: 1,
        environmentId: EnvironmentId.make("env"),
        threadId: ThreadId.make("bot"),
        messageId: MessageId.make("m1"),
        text,
        start: 0,
        end: text.length,
        prefix: "",
        suffix: "",
        ...(comment ? { comment } : {}),
      });
    expect(chatPreview(`For ${cite("Pick A.\n", "why?")}and ${cite("B")}then go.`)).toBe(
      'For "Pick A." (why?) and "B" then go.',
    );
  });
});
