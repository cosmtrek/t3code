import { describe, expect, it } from "vite-plus/test";

import { emptyViewTitle, itemMeta, minuteToMs, nextReplyText, type DraftSource } from "./inboxView";

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
    ["pending", "all", "Nothing pending"],
    ["pending", "dm", "No pending DMs"],
    ["waiting", "groups", "No waiting group topics"],
    ["all", "dm", "No DMs"],
  ] as const)("names an empty %s list filtered to %s", (view, filter, title) => {
    expect(emptyViewTitle(view, filter)).toBe(title);
  });
});

describe("itemMeta", () => {
  const author = (name: string) => ({ id: "u", name, isSelf: false });
  it.each([
    ["names the last author", 40, "Sam Okafor", "needs_reply", "40 replies · Sam Okafor"],
    ["leaves out a nameless author", 40, "  ", "needs_reply", "40 replies"],
    ["has nothing to say", 0, "", "needs_reply", null],
    ["leaves the author to a waiting topic's label", 1, "Sam", "waiting", "1 reply"],
  ] as const)("%s", (_case, replyCount, name, state, meta) => {
    expect(itemMeta({ replyCount, lastAuthor: author(name), state })).toBe(meta);
  });
});

describe("minuteToMs", () => {
  it("reads useNowMinute's zoneless minute as UTC", () => {
    expect(minuteToMs("2026-11-15T14:41")).toBe(Date.UTC(2026, 10, 15, 14, 41));
  });
});
