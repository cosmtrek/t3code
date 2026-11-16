import { describe, expect, it } from "vite-plus/test";

import type { InboxItem, InboxMessage } from "../types";
import {
  conversationRows,
  emptyViewTitle,
  mergeConversationPages,
  quoteOf,
  replyTargetOf,
  inView,
  itemMeta,
  minuteToMs,
  nextReplyText,
  type DraftSource,
} from "./inboxView";

const draft = (threadId: string, text: string): DraftSource => ({ threadId, text });

describe("nextReplyText", () => {
  it.each([
    ["a new thread replaces the one whose draft is shown", "old", draft("t1", "old"), null, ""],
    ["the thread withdraws its draft", "old", draft("t1", "old"), null, ""],
    ["the same thread rewrites its draft", "old", draft("t1", "old"), draft("t1", "new"), "new"],
    ["a draft lands in an empty box", "", null, draft("t1", "new"), "new"],
    ["the user edited the draft", "old, edited", draft("t1", "old"), null, "old, edited"],
    ["the user typed before any draft", "mine", null, draft("t1", "new"), "mine"],
  ] as const)("when %s", (_case, text, shown, next, expected) => {
    expect(nextReplyText(text, shown, next)).toBe(expected);
  });
});

describe("emptyViewTitle", () => {
  it.each([
    ["unread", "all", "Nothing unread"],
    ["unread", "dm", "No unread DMs"],
    ["waiting", "groups", "No waiting group topics"],
    ["all", "dm", "No DMs"],
  ] as const)("names an empty %s list filtered to %s", (view, filter, title) => {
    expect(emptyViewTitle(view, filter)).toBe(title);
  });
});

describe("itemMeta", () => {
  const author = (name: string) => ({ id: "u", name, isSelf: false });
  it.each([
    ["names the last author", 40, "Sam Okafor", false, "40 replies · Sam Okafor"],
    ["leaves out a nameless author", 40, "  ", false, "40 replies"],
    ["has nothing to say", 0, "", false, null],
    ["leaves the author to a waiting topic's label", 1, "Sam", true, "1 reply"],
  ] as const)("%s", (_case, replyCount, name, awaitingReply, meta) => {
    expect(itemMeta({ replyCount, lastAuthor: author(name), awaitingReply })).toBe(meta);
  });
});

describe("inView", () => {
  const topic = (unread: boolean) =>
    ({ id: "i", conversationKind: "group", unread, awaitingReply: false }) as InboxItem;
  it("keeps the open topic in Unread after it is read, and only that one", () => {
    expect(inView("unread", "all", topic(true))).toBe(true);
    expect(inView("unread", "all", topic(false))).toBe(false);
    expect(inView("unread", "all", topic(false), "i")).toBe(true);
    expect(inView("unread", "dm", topic(false), "i")).toBe(false);
  });
});

describe("minuteToMs", () => {
  it("reads useNowMinute's zoneless minute as UTC", () => {
    expect(minuteToMs("2026-11-15T14:41")).toBe(Date.UTC(2026, 10, 15, 14, 41));
  });
});

describe("conversationRows", () => {
  const message = (id: string, topicId: string, author = "Sam") =>
    ({
      id,
      topicId,
      text: `text ${id}`,
      author: { id: author, name: author, isSelf: false },
    }) as InboxMessage;
  const item = (topicId: string, rootMessageId: string) =>
    ({ id: `item-${topicId}`, topicId, rootMessageId, preview: `preview ${topicId}` }) as InboxItem;
  // Oldest first; t1's root r1 has a reply, t-old's root is older than what was read.
  const messages = [
    message("r1", "t1"),
    message("x1", "t-unlisted"),
    message("a1", "t1", "Kim"),
    message("o2", "t-old"),
    message("o3", "t-old"),
  ];
  const items = [item("t1", "r1"), item("t-old", "o1")];
  const shape = (kind: "dm" | "group" | "topic_group") =>
    conversationRows(messages, items, kind).map((row) => [
      row.message.id,
      row.item?.id ?? null,
      row.anchor,
      row.quote,
    ]);

  it("shows a topic group's topics once each, by root or the earliest message read", () => {
    expect(shape("topic_group")).toEqual([
      ["r1", "item-t1", true, null],
      ["x1", null, true, null],
      ["o2", "item-t-old", true, null],
    ]);
  });

  it("shows every message of a group, a reply quoting its topic's root", () => {
    expect(shape("group")).toEqual([
      ["r1", "item-t1", true, null],
      ["x1", null, true, null],
      ["a1", "item-t1", false, "Sam: text r1"],
      ["o2", "item-t-old", true, "preview t-old"],
      ["o3", "item-t-old", false, "preview t-old"],
    ]);
  });

  it("shows every message of a DM without quotes", () => {
    expect(shape("dm").map(([id, , anchor, quote]) => [id, anchor, quote])).toEqual([
      ["r1", true, null],
      ["x1", true, null],
      ["a1", false, null],
      ["o2", true, null],
      ["o3", false, null],
    ]);
  });

  it("cuts a quote at 40 characters", () => {
    expect(quoteOf("Sam", "a".repeat(41))).toBe(`Sam: ${"a".repeat(40)}…`);
  });
});

describe("replyTargetOf", () => {
  const root = {
    id: "r",
    text: "Who owns the retry budget?",
    author: { id: "u", name: "Sam", isSelf: false },
  } as InboxMessage;
  const detail = (kind: "dm" | "group", messages: ReadonlyArray<InboxMessage>) => ({
    item: { rootMessageId: "r" } as InboxItem,
    conversation: { id: "c", name: "c", kind },
    messages,
  });

  it("names the topic's root in a group, and nothing in a DM or without the root", () => {
    expect(replyTargetOf(detail("group", [root]))).toBe("Sam: Who owns the retry budget?");
    expect(replyTargetOf(detail("dm", [root]))).toBeNull();
    expect(replyTargetOf(detail("group", []))).toBeNull();
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
