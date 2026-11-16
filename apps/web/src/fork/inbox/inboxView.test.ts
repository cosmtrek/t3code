import { describe, expect, it } from "vite-plus/test";

import type { InboxConversation, InboxDelegation, InboxMessage } from "../types";
import {
  agentSignalsByConversation,
  anchorOf,
  conversationRows,
  emptyViewTitle,
  inView,
  lastMessageLine,
  mergeConversationPages,
  minuteToMs,
  quoteOf,
} from "./inboxView";

describe("emptyViewTitle", () => {
  it.each([
    ["unread", "all", "Nothing unread"],
    ["unread", "dm", "No unread DMs"],
    ["agent", "groups", "No delegations from groups"],
    ["all", "dm", "No DMs"],
  ] as const)("names an empty %s list filtered to %s", (view, filter, title) => {
    expect(emptyViewTitle(view, filter)).toBe(title);
  });
});

describe("inView", () => {
  const conversation = (unread: boolean, mentioned = false) =>
    ({ id: "c", kind: "group", unread, mentioned }) as InboxConversation;
  const agent = (unseen: number) => ({ unseen, drafts: 0, live: 1 });

  it("lists in Unread what has new messages, a mention, or an agent result", () => {
    expect(inView("unread", "all", conversation(true), undefined)).toBe(true);
    expect(inView("unread", "all", conversation(false, true), undefined)).toBe(true);
    expect(inView("unread", "all", conversation(false), agent(1))).toBe(true);
    expect(inView("unread", "all", conversation(false), agent(0))).toBe(false);
    expect(inView("all", "all", conversation(false), undefined)).toBe(true);
  });

  it("keeps the open conversation in Unread after it is read, and only that one", () => {
    expect(inView("unread", "all", conversation(false), undefined, "c")).toBe(true);
    expect(inView("unread", "dm", conversation(false), undefined, "c")).toBe(false);
  });
});

describe("agentSignalsByConversation", () => {
  it("counts each conversation's unseen results, drafts, and live threads", () => {
    const delegation = (conversationId: string, extra: Partial<InboxDelegation>) =>
      ({
        conversationId,
        agentUnseen: false,
        hasDraft: false,
        thread: { detachedAt: null },
        ...extra,
      }) as InboxDelegation;
    const signals = agentSignalsByConversation([
      delegation("a", { agentUnseen: true }),
      delegation("a", { hasDraft: true }),
      delegation("b", { thread: null }),
    ]);
    expect(signals.get("a")).toEqual({ unseen: 1, drafts: 1, live: 2 });
    expect(signals.get("b")).toEqual({ unseen: 0, drafts: 0, live: 0 });
  });
});

describe("lastMessageLine", () => {
  const line = (kind: "dm" | "group", name: string, isSelf: boolean) =>
    lastMessageLine({
      kind,
      lastMessage: { id: "m", createdAt: "", author: { id: "u", name, isSelf }, preview: "hi" },
    });
  it.each([
    ["names the author in a group", line("group", "Sam", false), "Sam: hi"],
    ["leaves the other person out of a DM", line("dm", "Sam", false), "hi"],
    ["says when I wrote last", line("dm", "Me", true), "You: hi"],
    ["leaves out a nameless author", line("group", " ", false), "hi"],
  ])("%s", (_case, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe("minuteToMs", () => {
  it("reads useNowMinute's zoneless minute as UTC", () => {
    expect(minuteToMs("2026-11-15T14:41")).toBe(Date.UTC(2026, 10, 15, 14, 41));
  });
});

describe("conversationRows", () => {
  const message = (id: string, replyTo: InboxMessage["replyTo"] = null, author = "Sam") =>
    ({
      id,
      replyTo,
      text: `text ${id}`,
      author: { id: author, name: author, isSelf: false },
    }) as InboxMessage;

  it("quotes what a reply answers: the loaded message, else the adapter's preview", () => {
    const rows = conversationRows(
      [
        message("r1"),
        message("a1", { id: "r1", authorName: null, preview: null }, "Kim"),
        message("o2", { id: "o1", authorName: "Lee", preview: "older text" }),
        message("o3", { id: "gone", authorName: null, preview: null }),
      ],
      [{ id: "d1", anchorMessageId: "r1" } as InboxDelegation],
    );
    expect(rows.map((row) => [row.message.id, row.quote, row.delegations.length])).toEqual([
      ["r1", null, 1],
      ["a1", "Sam: text r1", 0],
      ["o2", "Lee: older text", 0],
      ["o3", "An earlier message", 0],
    ]);
  });

  it("cuts a quote at 40 characters", () => {
    expect(quoteOf("Sam", "a".repeat(41))).toBe(`Sam: ${"a".repeat(40)}…`);
  });
});

describe("anchorOf", () => {
  it("delegates a reply thread from its root and a range from the message itself", () => {
    const reply = { id: "m2", rootId: "m1" } as InboxMessage;
    expect(anchorOf(reply, "chain")).toBe("m1");
    expect(anchorOf(reply, "range")).toBe("m2");
    expect(anchorOf({ id: "m1", rootId: null } as InboxMessage, "chain")).toBe("m1");
  });
});

describe("mergeConversationPages", () => {
  const message = (id: string) => ({ id }) as InboxMessage;
  const newest = { messages: [message("m3"), message("m4")], nextCursor: "c3" };

  it("puts older pages above the newest one, once each", () => {
    const older = {
      messages: [message("m1"), message("m2"), message("m3")],
      nextCursor: "c1",
      joinId: "m3",
    };
    expect(mergeConversationPages(newest, older)).toMatchObject({
      messages: ["m1", "m2", "m3", "m4"].map(message),
      nextCursor: "c1",
    });
  });

  it("drops older pages once the newest page no longer reaches them", () => {
    const older = { messages: [message("m1")], nextCursor: null, joinId: "m2" };
    expect(mergeConversationPages(newest, older)).toEqual({ ...newest, older: null });
  });
});
