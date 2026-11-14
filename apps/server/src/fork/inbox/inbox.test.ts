// @effect-diagnostics globalDate:off - Fixed wall-clock timestamps for pure derivation tests.
import { describe, expect, it } from "@effect/vitest";

import { firstMessage, fillTemplate, parseFallbackReply, threadTitle } from "./context.ts";
import { compareItems, deriveItem, itemIdFor, type TopicFacts } from "./derive.ts";
import { InboxStore } from "./store.ts";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const facts = (overrides: Partial<TopicFacts> = {}): TopicFacts => ({
  conversation: { kind: "group", relevant: true, muted: false },
  topic: {
    lastMessageAt: hoursAgo(1),
    lastAuthor: { id: "u2", name: "Other", isSelf: false },
    participatedBySelf: false,
  },
  mentionsSelf: false,
  mark: null,
  threadRunning: false,
  hasDraft: false,
  now: NOW,
  ...overrides,
});

describe("deriveItem", () => {
  it.each([
    [
      "a direct message waits for me",
      facts({ conversation: { kind: "dm", relevant: true, muted: false } }),
      "needs_reply",
    ],
    ["a mention waits for me", facts({ mentionsSelf: true }), "needs_reply"],
    [
      "a reply in a topic I joined waits for me",
      facts({
        topic: {
          lastMessageAt: hoursAgo(1),
          lastAuthor: { id: "u2", name: "Other", isSelf: false },
          participatedBySelf: true,
        },
      }),
      "needs_reply",
    ],
    ["a new topic in a followed conversation is open", facts(), "open"],
    [
      "my own last message waits for the other side",
      facts({
        topic: {
          lastMessageAt: hoursAgo(1),
          lastAuthor: { id: "me", name: "Me", isSelf: true },
          participatedBySelf: true,
        },
      }),
      "waiting",
    ],
    [
      "a running thread is investigating",
      facts({ mentionsSelf: true, threadRunning: true }),
      "investigating",
    ],
    [
      "a draft wins over a running thread",
      facts({ threadRunning: true, hasDraft: true }),
      "drafted",
    ],
  ] as const)("%s", (_name, input, state) => {
    expect(deriveItem(input).state).toBe(state);
  });

  it("highlights waiting longer than a day", () => {
    const waiting = (hours: number) =>
      deriveItem(
        facts({
          topic: {
            lastMessageAt: hoursAgo(hours),
            lastAuthor: { id: "me", name: "Me", isSelf: true },
            participatedBySelf: true,
          },
        }),
      );
    expect(waiting(23).highlight).toBe(false);
    expect(waiting(25).highlight).toBe(true);
  });

  it("keeps a mark until someone else writes after its watermark", () => {
    const mark = { state: "done" as const, watermarkMessageAt: hoursAgo(2) };
    const at = (lastMessageAt: string, isSelf: boolean) =>
      deriveItem(
        facts({
          mentionsSelf: true,
          mark,
          topic: {
            lastMessageAt,
            lastAuthor: { id: isSelf ? "me" : "u2", name: "x", isSelf },
            participatedBySelf: true,
          },
        }),
      );
    expect(at(hoursAgo(2), false)).toMatchObject({ state: "done", reopened: false });
    expect(at(hoursAgo(1), true)).toMatchObject({ state: "done", reopened: false });
    expect(at(hoursAgo(1), false)).toMatchObject({ state: "needs_reply", reopened: true });
  });

  it("ranks by category weight times wait, open topics after pending ones", () => {
    const direct = deriveItem(
      facts({ mentionsSelf: true, topic: { ...facts().topic, lastMessageAt: hoursAgo(1) } }),
    );
    const joined = deriveItem(
      facts({ topic: { ...facts().topic, participatedBySelf: true, lastMessageAt: hoursAgo(1) } }),
    );
    const joinedOlder = deriveItem(
      facts({ topic: { ...facts().topic, participatedBySelf: true, lastMessageAt: hoursAgo(8) } }),
    );
    const followed = deriveItem(facts());
    const sorted = [followed, joined, direct, joinedOlder].toSorted(compareItems);
    expect(sorted).toEqual([joinedOlder, direct, joined, followed]);
  });

  it("derives stable item ids", () => {
    const key = { channelId: "a", conversationId: "b", topicId: "c" };
    expect(itemIdFor(key)).toBe(itemIdFor({ ...key }));
    expect(itemIdFor(key)).not.toBe(itemIdFor({ ...key, topicId: "d" }));
    expect(itemIdFor(key)).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("delegation text", () => {
  it("fills known placeholders only", () => {
    expect(
      fillTemplate("{contextDir} {note} {openUrl} {other}", {
        contextDir: "/x",
        note: "  ",
        openUrl: null,
      }),
    ).toBe("/x (none) (not available) {other}");
  });

  it("adds the link and the write-back contract when the template lacks them", () => {
    const text = firstMessage({
      template: "Look at {contextDir}/context.md",
      contextDir: "/ctx",
      note: "",
      openUrl: "https://chat.example.com/t/1",
    });
    expect(text).toContain("Open in app: https://chat.example.com/t/1");
    expect(text).toContain("/ctx/conclusion.md");
    expect(text).toContain("<draft>");
    const complete = firstMessage({
      template: "{openUrl} {contextDir}/conclusion.md {contextDir}/draft.md",
      contextDir: "/ctx",
      note: "",
      openUrl: "https://chat.example.com/t/1",
    });
    expect(complete).toBe("https://chat.example.com/t/1 /ctx/conclusion.md /ctx/draft.md");
  });

  it("parses the last tagged conclusion and draft", () => {
    expect(
      parseFallbackReply(
        "<draft>old</draft> text <conclusion>\n Cause found \n</conclusion>\n<draft>new reply</draft>",
      ),
    ).toEqual({ conclusion: "Cause found", draft: "new reply" });
    expect(parseFallbackReply("<draft>  </draft> nothing")).toEqual({
      conclusion: null,
      draft: null,
    });
  });

  it("titles threads with a short summary", () => {
    expect(threadTitle("Chat", "Jordan", "The nightly export job failed again today")).toBe(
      "Chat·Jordan·The nightly export j",
    );
  });
});

describe("InboxStore", () => {
  it("migrates and round-trips marks and links", () => {
    const store = new InboxStore(":memory:");
    const key = { channelId: "a", conversationId: "b", topicId: "c" };
    store.setMark({
      ...key,
      state: "ignored",
      markedAt: hoursAgo(1),
      watermarkMessageAt: hoursAgo(2),
    });
    store.setMark({
      ...key,
      state: "done",
      markedAt: hoursAgo(0),
      watermarkMessageAt: hoursAgo(1),
    });
    expect(store.listMarks("a")).toEqual([
      { ...key, state: "done", markedAt: hoursAgo(0), watermarkMessageAt: hoursAgo(1) },
    ]);
    store.clearMark(key);
    expect(store.listMarks("a")).toEqual([]);
    const itemId = itemIdFor(key);
    store.addLink({ ...key, itemId, threadId: "t1", projectId: "p", createdAt: hoursAgo(1) });
    store.detachLink(itemId, "t1", "deleted", hoursAgo(0));
    expect(store.linksForItem(itemId)).toEqual([
      {
        ...key,
        itemId,
        threadId: "t1",
        projectId: "p",
        createdAt: hoursAgo(1),
        detachedAt: hoursAgo(0),
        detachedReason: "deleted",
      },
    ]);
    store.close();
  });
});
