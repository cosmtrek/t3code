// @effect-diagnostics globalDate:off nodeBuiltinImport:off - Fixed wall-clock timestamps; context folders are temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { applyFallback, readArtifacts, recordSent } from "./artifacts.ts";
import {
  buildContextMarkdown,
  firstMessage,
  fillTemplate,
  followUpsOf,
  mediaFileName,
  parseFallbackReply,
  threadTitle,
} from "./context.ts";
import {
  compareItems,
  countsTowardBadge,
  deriveItem,
  itemIdFor,
  sortMessages,
  type TopicFacts,
} from "./derive.ts";
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
  lastOtherMessageAt: hoursAgo(1),
  read: null,
  readAllBefore: hoursAgo(24 * 7),
  runCompletedAt: null,
  now: NOW,
  ...overrides,
});

const mine = (lastMessageAt: string) => ({
  lastMessageAt,
  lastAuthor: { id: "me", name: "Me", isSelf: true },
  participatedBySelf: true,
});
const seen = (readAt: string | null, agentSeenAt: string | null = null, pinnedUnread = false) => ({
  readAt,
  agentSeenAt,
  pinnedUnread,
});

describe("deriveItem", () => {
  it.each([
    [
      "a direct message",
      facts({ conversation: { kind: "dm", relevant: true, muted: false } }),
      "direct",
    ],
    ["a mention", facts({ mentionsSelf: true }), "direct"],
    [
      "a reply in a topic I joined",
      facts({
        topic: { ...mine(hoursAgo(1)), lastAuthor: { id: "u2", name: "x", isSelf: false } },
      }),
      "participated",
    ],
    ["a topic in a followed conversation", facts(), "followed"],
    [
      "a topic in a muted conversation",
      facts({ conversation: { kind: "group", relevant: true, muted: true } }),
      "other",
    ],
  ] as const)("files %s", (_name, input, category) => {
    expect(deriveItem(input).category).toBe(category);
  });

  it.each([
    ["a message nobody read is unread", facts(), { unread: true, awaitingReply: false }],
    ["reading through it in T3 reads it", facts({ read: seen(hoursAgo(1)) }), { unread: false }],
    [
      "a later message from them unreads it again",
      facts({ read: seen(hoursAgo(2)) }),
      { unread: true },
    ],
    [
      "reading it in the chat app reads it",
      facts({ topic: { ...facts().topic, selfReadThroughAt: hoursAgo(1) } }),
      { unread: false },
    ],
    [
      "an offset time compares as an instant",
      facts({ topic: { ...facts().topic, selfReadThroughAt: "2026-11-14T19:00:00+08:00" } }),
      { unread: false },
    ],
    [
      "my own last message reads it and waits on them",
      facts({ topic: mine(hoursAgo(1)), lastOtherMessageAt: hoursAgo(2) }),
      { unread: false, awaitingReply: true },
    ],
    [
      "anything before read-all-before is read",
      facts({ readAllBefore: hoursAgo(0.5) }),
      { unread: false },
    ],
    [
      "a pin keeps it unread past every read mark",
      facts({
        read: seen(hoursAgo(0), null, true),
        topic: { ...facts().topic, selfReadThroughAt: hoursAgo(0) },
      }),
      { unread: true },
    ],
    [
      "a run that finished after I looked is unseen",
      facts({
        topic: mine(hoursAgo(3)),
        runCompletedAt: hoursAgo(1),
        read: seen(null, hoursAgo(2)),
      }),
      { unread: true, agentUnseen: true },
    ],
    [
      "a run I saw is not",
      facts({
        topic: mine(hoursAgo(3)),
        runCompletedAt: hoursAgo(1),
        read: seen(null, hoursAgo(1)),
      }),
      { unread: false, agentUnseen: false },
    ],
    [
      "a running thread has no unseen run, while their message stays unread",
      facts({ runCompletedAt: null, read: seen(null, hoursAgo(5)) }),
      { unread: true, agentUnseen: false },
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(deriveItem(input)).toMatchObject(expected);
  });

  it("shows a run that ends after I opened the topic mid-run", () => {
    // Opened mid-run: the client had no finished run to report, so only the message mark moved.
    const read = seen(hoursAgo(1), hoursAgo(5));
    expect(deriveItem(facts({ read, runCompletedAt: null })).unread).toBe(false);
    expect(deriveItem(facts({ read, runCompletedAt: hoursAgo(0) }))).toMatchObject({
      unread: true,
      agentUnseen: true,
    });
  });

  it("counts agent results and unread topics I am part of toward the badge", () => {
    expect(countsTowardBadge({ unread: true, agentUnseen: false, category: "direct" })).toBe(true);
    expect(countsTowardBadge({ unread: true, agentUnseen: false, category: "participated" })).toBe(
      true,
    );
    expect(countsTowardBadge({ unread: true, agentUnseen: false, category: "followed" })).toBe(
      false,
    );
    expect(countsTowardBadge({ unread: true, agentUnseen: true, category: "other" })).toBe(true);
    expect(countsTowardBadge({ unread: false, agentUnseen: false, category: "direct" })).toBe(
      false,
    );
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

  it("lists the newest first whatever the state, ties by id", () => {
    const item = (id: string, lastMessageAt: string) => ({ id, lastMessageAt });
    const pendingOld = item("b", hoursAgo(8));
    const waitingNew = item("c", hoursAgo(1));
    const tieA = item("a", hoursAgo(3));
    const tieB = item("d", hoursAgo(3));
    expect([pendingOld, tieB, waitingNew, tieA].toSorted(compareItems)).toEqual([
      waitingNew,
      tieA,
      tieB,
      pendingOld,
    ]);
  });

  it("derives stable item ids", () => {
    const key = { channelId: "a", conversationId: "b", topicId: "c" };
    expect(itemIdFor(key)).toBe(itemIdFor({ ...key }));
    expect(itemIdFor(key)).not.toBe(itemIdFor({ ...key, topicId: "d" }));
    expect(itemIdFor(key)).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("follow-ups", () => {
  it("keeps the latest five rounds after the delegation", () => {
    const messages = Array.from({ length: 7 }, (_, index) => ({
      role: "user" as const,
      text: `q${index}`,
      runId: null,
      streaming: false,
      at: hoursAgo(10 - index),
    }));
    expect(followUpsOf(messages, "/x").map((entry) => entry.text)).toEqual([
      "q2",
      "q3",
      "q4",
      "q5",
      "q6",
    ]);
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
      skippedMessages: 0,
    });
    expect(text).toContain("Open in app: https://chat.example.com/t/1");
    expect(text).toContain("/ctx/conclusion.md");
    expect(text).toContain("<draft>");
    const complete = firstMessage({
      template: "{openUrl} {contextDir}/conclusion.md {contextDir}/draft.md",
      contextDir: "/ctx",
      note: "",
      openUrl: "https://chat.example.com/t/1",
      skippedMessages: 0,
    });
    expect(complete).toBe("https://chat.example.com/t/1 /ctx/conclusion.md /ctx/draft.md");
  });

  it("tells the thread about messages it is not given, and names nameless authors", () => {
    const missing = "2 messages in this topic could not be read and are missing";
    expect(
      firstMessage({
        template: "{contextDir}/conclusion.md {contextDir}/draft.md",
        contextDir: "/ctx",
        note: "",
        openUrl: null,
        skippedMessages: 2,
      }),
    ).toContain(`${missing} from context.md.`);
    const markdown = buildContextMarkdown({
      channelName: "Chat",
      conversation: { name: "", kind: "dm" },
      messages: [
        {
          id: "m1",
          topicId: "t",
          createdAt: hoursAgo(1),
          author: { id: "u2", name: " ", isSelf: false },
          mentionsSelf: false,
          text: "hello",
          attachments: [],
          links: [],
        },
      ],
      images: [],
      senderName: "",
      senderHistory: [],
      contextDir: "/ctx",
      openUrl: null,
      skippedMessages: 2,
    });
    expect(markdown.split("\n").slice(0, 3)).toEqual(["# Unknown", "", `${missing} below.`]);
    expect(markdown).toContain(`### Unknown · ${hoursAgo(1)}`);
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

  it.each([
    ["Hey, the export failed", "Jordan Lee: Hey, the export failed"],
    [
      "Hey, the nightly export job failed again and nobody noticed until noon",
      "Jordan Lee: Hey, the nightly export job failed again and…",
    ],
    [
      "The export failed again last night. Can you look before standup?",
      "Jordan Lee: The export failed again last night.",
    ],
    // No spaces to break at: cut at the limit.
    ["导".repeat(60), `Jordan Lee: ${"导".repeat(48)}…`],
  ])("titles a thread from %j", (preview, title) => {
    expect(threadTitle("Jordan Lee", preview)).toBe(title);
  });
});

describe("InboxStore", () => {
  it("migrates and round-trips reads and links", () => {
    const store = new InboxStore(":memory:");
    const key = { channelId: "a", conversationId: "b", topicId: "c" };
    store.markRead(key, { readAt: hoursAgo(1) });
    store.pinUnread(key);
    store.markRead(key, { agentSeenAt: hoursAgo(2) });
    // A stale view moves nothing back.
    store.markRead(key, { readAt: hoursAgo(3), agentSeenAt: hoursAgo(3) });
    expect(store.listReads("a")).toEqual([
      { ...key, readAt: hoursAgo(1), agentSeenAt: hoursAgo(2), pinnedUnread: false },
    ]);
    store.pinUnread(key);
    expect(store.readAllBefore("a", hoursAgo(5))).toBe(hoursAgo(5));
    expect(store.readAllBefore("a", hoursAgo(4))).toBe(hoursAgo(5));
    store.markAllRead("a", hoursAgo(0));
    store.markAllRead("a", hoursAgo(2));
    expect(store.readAllBefore("a", hoursAgo(9))).toBe(hoursAgo(0));
    expect(store.listReads("a")[0]?.pinnedUnread).toBe(false);
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

  it("carries done and ignored marks over as read", async () => {
    const file = NodePath.join(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inbox-")),
      "db",
    );
    const v1 = new NodeSqlite.DatabaseSync(file);
    v1.exec(`CREATE TABLE marks (
      channel_id TEXT, conversation_id TEXT, topic_id TEXT, state TEXT, marked_at TEXT,
      watermark_message_at TEXT);
      CREATE TABLE links (item_id TEXT);
      INSERT INTO marks VALUES ('a', 'b', 'done', 'done', '${hoursAgo(0)}', '${hoursAgo(1)}');
      INSERT INTO marks VALUES ('a', 'b', 'ignored', 'ignored', '${hoursAgo(0)}', '${hoursAgo(2)}');
      PRAGMA user_version = 1;`);
    v1.close();
    const store = new InboxStore(file);
    const read = { conversationId: "b", agentSeenAt: null, pinnedUnread: false, channelId: "a" };
    expect(store.listReads("a").toSorted((x, y) => x.topicId.localeCompare(y.topicId))).toEqual([
      { ...read, topicId: "done", readAt: hoursAgo(1) },
      { ...read, topicId: "ignored", readAt: hoursAgo(2) },
    ]);
    store.close();
  });
});

describe("topic signals", () => {
  const message = (id: string, minute: number, isSelf: boolean, mentionsSelf = false) => ({
    id,
    topicId: "t",
    createdAt: new Date(NOW + minute * 60_000).toISOString(),
    author: { id: isSelf ? "me" : "u2", name: "x", isSelf },
    mentionsSelf,
    text: id,
    attachments: [],
    links: [],
  });

  it("sorts pages by time", () => {
    // Newest page first, as an adapter may serve them.
    const sorted = sortMessages([
      message("c", 3, false, true),
      message("b", 2, true),
      message("a", 1, false, true),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("context media", () => {
  it("gives every message and key its own file", () => {
    const names = [
      mediaFileName("a/b", "x", "image/png"),
      mediaFileName("a?b", "x", "image/png"),
      mediaFileName("a", "b-x", "image/png"),
      mediaFileName("a-b", "x", "image/png"),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(names[0]).toMatch(/^[0-9a-f]{32}\.png$/);
    expect(mediaFileName("a/b", "x", "text/html")).toMatch(/\.bin$/);
  });

  it("matches downloaded images by key, not by name", () => {
    const markdown = buildContextMarkdown({
      channelName: "Chat",
      conversation: { name: "Team", kind: "group" },
      messages: [
        {
          id: "m1",
          topicId: "t",
          createdAt: hoursAgo(1),
          author: { id: "u2", name: "Other", isSelf: false },
          mentionsSelf: false,
          text: "two screenshots",
          attachments: [
            { key: "k1", kind: "image", name: "image.png" },
            { key: "k2", kind: "image", name: "image.png" },
          ],
          links: [],
        },
      ],
      images: [
        { messageId: "m1", key: "k2", path: "/ctx/media/second.png" },
        { messageId: "m1", key: "k1", path: "/ctx/media/first.png" },
      ],
      senderName: "Other",
      senderHistory: [],
      contextDir: "/ctx",
      openUrl: null,
      skippedMessages: 0,
    });
    expect(markdown.indexOf("/ctx/media/first.png")).toBeLessThan(
      markdown.indexOf("/ctx/media/second.png"),
    );
  });
});

describe("tagged-reply fallback", () => {
  const folder = () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-artifacts-"));
  const read = (dir: string, file: string) =>
    NodeFSP.readFile(NodePath.join(dir, file), "utf8").catch(() => null);

  it("lets a later run replace what an earlier run's tags wrote", async () => {
    const dir = await folder();
    await applyFallback(dir, "run-1", { conclusion: "first look", draft: "first reply" });
    await applyFallback(dir, "run-2", { conclusion: null, draft: "corrected reply" });
    expect(await readArtifacts(dir)).toEqual({
      conclusion: "first look",
      draft: "corrected reply",
    });
    // The same run twice is a no-op.
    await NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "edited by the thread\n");
    await applyFallback(dir, "run-2", { conclusion: null, draft: "corrected reply" });
    expect(await read(dir, "draft.md")).toBe("edited by the thread\n");
  });

  it("never replaces a file the thread wrote itself", async () => {
    const dir = await folder();
    await NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "from the file\n");
    await applyFallback(dir, "run-1", { conclusion: "tagged", draft: "from tags" });
    expect(await readArtifacts(dir)).toEqual({ conclusion: "tagged", draft: "from the file" });
    // A thread that rewrote a fallback file owns it from then on.
    await NodeFSP.writeFile(NodePath.join(dir, "conclusion.md"), "rewritten\n");
    await applyFallback(dir, "run-2", { conclusion: "newer tags", draft: null });
    expect(await read(dir, "conclusion.md")).toBe("rewritten\n");
  });

  it("keeps a thread's write that lands while the fallback is writing", async () => {
    const dir = await folder();
    await applyFallback(
      dir,
      "run-1",
      { conclusion: null, draft: "from tags" },
      {
        beforeWrite: (file) => NodeFSP.writeFile(NodePath.join(dir, file), "thread wrote\n"),
      },
    );
    expect(await read(dir, "draft.md")).toBe("thread wrote\n");
    // Owned by the inbox, then rewritten mid-replacement: the thread still wins.
    await NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "x\n");
    const owned = await folder();
    await applyFallback(owned, "run-1", { conclusion: null, draft: "first" });
    await applyFallback(
      owned,
      "run-2",
      { conclusion: null, draft: "second" },
      {
        beforeWrite: (file) => NodeFSP.writeFile(NodePath.join(owned, file), "thread wrote\n"),
      },
    );
    expect(await read(owned, "draft.md")).toBe("thread wrote\n");
    expect((await NodeFSP.readdir(owned)).filter((file) => file.includes(".aside"))).toEqual([]);
  });

  it("applies one run once when two reads race, and the next run still updates", async () => {
    const dir = await folder();
    await applyFallback(dir, "run-1", { conclusion: null, draft: "one" });
    let other: Promise<void> | null = null;
    await applyFallback(
      dir,
      "run-2",
      { conclusion: null, draft: "two" },
      {
        // A second read of the same run arrives while the first is about to write; this one
        // carries on once that read has finished or is waiting its turn.
        beforeWrite: () =>
          new Promise<void>((resume) => {
            other = applyFallback(
              dir,
              "run-2",
              { conclusion: null, draft: "two" },
              { onQueued: resume },
            );
            void other.then(resume);
          }),
      },
    );
    await other;
    expect(await read(dir, "draft.md")).toBe("two\n");
    await applyFallback(dir, "run-3", { conclusion: null, draft: "three" });
    expect(await read(dir, "draft.md")).toBe("three\n");
  });
});

describe("sent records", () => {
  it("keeps both of two sends made in the same millisecond", async () => {
    const itemDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sent-"));
    const sentAt = "2026-11-14T12:00:00.000Z";
    for (const [messageId, text] of [
      ["m-1", "first"],
      ["m-2", "second"],
    ] as const) {
      await recordSent({ itemDir, draftDir: null, draftAtSend: null, text, messageId, sentAt });
    }
    const files = (await NodeFSP.readdir(itemDir)).filter((file) => file.startsWith("sent."));
    const texts = await Promise.all(
      files.map((file) => NodeFSP.readFile(NodePath.join(itemDir, file), "utf8")),
    );
    expect(texts.map((text) => text.trim().split("\n").at(-1)).toSorted()).toEqual([
      "first",
      "second",
    ]);
  });
});
