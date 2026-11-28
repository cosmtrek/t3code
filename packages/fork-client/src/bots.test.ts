import { describe, expect, it } from "vite-plus/test";

import {
  botAttention,
  botRowStatus,
  botWorkThreadKeys,
  pendingBotMessage,
  startsChatBreak,
  withPendingMessages,
  type BotChatMessage,
  type BotSummary,
} from "./bots.ts";

const bot = (extra: Partial<BotSummary>) =>
  ({
    id: "b",
    name: "Bot",
    working: false,
    paused: false,
    lastMessage: null,
    unread: 0,
    questions: 0,
    workThreadId: null,
    ...extra,
  }) as BotSummary;

const said = { role: "bot", text: "hi", createdAt: "2026-11-27T10:00:00Z" } as const;

describe("botRowStatus", () => {
  it("shows the most pressing status", () => {
    const busy = bot({ questions: 1, unread: 2, working: true, paused: true, lastMessage: said });
    expect(botRowStatus(busy, "approval")).toEqual({ kind: "question" });
    expect(botRowStatus({ ...busy, questions: 0 }, "approval")).toEqual({
      kind: "blocked",
      status: "approval",
    });
    expect(botRowStatus({ ...busy, questions: 0 }, null)).toEqual({ kind: "unread", count: 2 });
    expect(botRowStatus({ ...busy, questions: 0, unread: 0 }, null)).toEqual({ kind: "working" });
    expect(botRowStatus(bot({ paused: true, lastMessage: said }), null)).toEqual({
      kind: "paused",
    });
    expect(botRowStatus(bot({ lastMessage: said }), null)).toEqual({
      kind: "age",
      at: said.createdAt,
    });
    expect(botRowStatus(bot({}), null)).toEqual({ kind: "none" });
  });
});

describe("botAttention", () => {
  it("ranks a failed work thread apart from one waiting on the user", () => {
    expect(botAttention({ kind: "blocked", status: "failed" })).toBe("failed");
    expect(botAttention({ kind: "blocked", status: "input" })).toBe("attention");
    expect(botAttention({ kind: "question" })).toBe("attention");
    expect(botAttention({ kind: "paused" })).toBeNull();
  });
});

describe("botWorkThreadKeys", () => {
  it("keys each bot's own thread by environment", () => {
    const listings = [
      { environmentId: "e1", bots: [bot({ workThreadId: "t1" }), bot({})] },
      { environmentId: "e2", bots: [bot({ workThreadId: "t2" })] },
    ];
    expect(botWorkThreadKeys(listings)).toEqual(["e1:t1", "e2:t2"]);
  });
});

describe("startsChatBreak", () => {
  const at = (role: "user" | "bot" | "error", createdAt: string) => ({ role, createdAt });

  it("marks each later post the bot makes without the user writing in between", () => {
    const chat = [
      at("user", "2026-11-28T06:46:05Z"),
      at("bot", "2026-11-28T06:46:24Z"),
      at("bot", "2026-11-28T06:49:02Z"),
      at("bot", "2026-11-28T06:51:16Z"),
    ];
    expect(chat.map((message, index) => startsChatBreak(chat[index - 1], message))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("keeps posts made together as one", () => {
    expect(
      startsChatBreak(at("bot", "2026-11-28T06:46:24.000Z"), at("bot", "2026-11-28T06:46:24.004Z")),
    ).toBe(false);
  });

  it("marks a long gap or a new day even in an exchange", () => {
    expect(
      startsChatBreak(at("bot", "2026-11-28T06:00:00Z"), at("user", "2026-11-28T06:30:00Z")),
    ).toBe(true);
    const utcDay = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format;
    const evening = at("bot", "2026-11-27T23:58:00Z");
    const morning = at("user", "2026-11-28T00:01:00Z");
    expect(startsChatBreak(evening, morning, utcDay)).toBe(true);
    expect(
      startsChatBreak(at("user", "2026-11-28T06:00:00Z"), at("bot", "2026-11-28T06:02:00Z")),
    ).toBe(false);
  });
});

describe("withPendingMessages", () => {
  const line = (id: string, text: string, role: BotChatMessage["role"] = "user") =>
    ({ id, role, text, createdAt: "2026-11-27T10:00:00Z", turnRunId: null }) as BotChatMessage;
  const before = [line("m1", "hello"), line("m2", "hi", "bot")];

  it("shows a sent message until a read carries the server's copy", () => {
    const sent = pendingBotMessage(" hello ", before);
    expect(withPendingMessages(before, [sent]).map((m) => m.id)).toEqual(["m1", "m2", sent.key]);
    const read = [...before, line("m3", "hello")];
    expect(withPendingMessages(read, [sent])).toBe(read);
  });

  it("matches each copy once, so the same text sent twice shows twice", () => {
    const first = pendingBotMessage("again", before);
    const second = pendingBotMessage("again", before);
    const read = [...before, line("m3", "again")];
    expect(withPendingMessages(read, [first, second]).map((m) => m.id)).toEqual([
      "m1",
      "m2",
      "m3",
      second.key,
    ]);
  });

  it("keeps a failed send in view", () => {
    const failed = { ...pendingBotMessage("hello", before), failed: true };
    const read = [...before, line("m3", "hello")];
    expect(withPendingMessages(read, [failed]).at(-1)?.pending).toBe(failed);
  });
});
