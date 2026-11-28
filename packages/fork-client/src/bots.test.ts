import { describe, expect, it } from "vite-plus/test";

import { botAttention, botRowStatus, botWorkThreadKeys, type BotSummary } from "./bots.ts";

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
