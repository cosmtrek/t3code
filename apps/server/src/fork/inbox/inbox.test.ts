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
  agentUnseen,
  compareConversations,
  conversationCountsTowardBadge,
  delegationIdFor,
  deriveConversation,
  messagesInRange,
  rangeUntil,
  scopeIsChain,
  sortMessages,
} from "./derive.ts";
import { InboxStore } from "./store.ts";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const OTHER = { id: "u2", name: "Other", isSelf: false };
const ME = { id: "me", name: "Me", isSelf: true };

type ConversationInput = Parameters<typeof deriveConversation>[0];

const conversation = (
  overrides: Partial<ConversationInput["conversation"]> = {},
): ConversationInput["conversation"] => ({
  lastMessage: { id: "m", createdAt: hoursAgo(1), author: OTHER, preview: "hi" },
  lastOtherMessageAt: hoursAgo(1),
  lastSelfMessageAt: null,
  lastMentionAt: null,
  ...overrides,
});
const facts = (overrides: Partial<ConversationInput> = {}): ConversationInput => ({
  conversation: conversation(),
  read: null,
  readAllBefore: hoursAgo(24 * 7),
  ...overrides,
});
const seen = (readAt: string | null, pinnedUnread = false) => ({ readAt, pinnedUnread });

describe("deriveConversation", () => {
  it.each([
    ["a message nobody read is unread", facts(), { unread: true }],
    ["reading through it in T3 reads it", facts({ read: seen(hoursAgo(1)) }), { unread: false }],
    [
      "a later message from them unreads it again",
      facts({ read: seen(hoursAgo(2)) }),
      { unread: true },
    ],
    [
      "reading it in the chat app reads it",
      facts({ conversation: conversation({ selfReadThroughAt: hoursAgo(1) }) }),
      { unread: false },
    ],
    [
      "an offset time compares as an instant",
      facts({ conversation: conversation({ selfReadThroughAt: "2026-11-14T19:00:00+08:00" }) }),
      { unread: false },
    ],
    [
      "my own last message reads it",
      facts({
        conversation: conversation({
          lastMessage: { id: "m", createdAt: hoursAgo(1), author: ME, preview: "ok" },
          lastOtherMessageAt: hoursAgo(2),
        }),
      }),
      { unread: false },
    ],
    [
      "anything before read-all-before is read",
      facts({ readAllBefore: hoursAgo(0.5) }),
      { unread: false },
    ],
    [
      "a pin keeps it unread past every read mark",
      facts({
        read: seen(hoursAgo(0), true),
        conversation: conversation({ selfReadThroughAt: hoursAgo(0) }),
      }),
      { unread: true },
    ],
    [
      "a mention I have not read is a mention",
      facts({ conversation: conversation({ lastMentionAt: hoursAgo(1) }) }),
      { mentioned: true },
    ],
    [
      "a mention I answered since, anywhere in the chat, is not",
      facts({
        conversation: conversation({ lastMentionAt: hoursAgo(2), lastSelfMessageAt: hoursAgo(1) }),
      }),
      { mentioned: false, unread: true },
    ],
    [
      "a mention read in the chat app is not",
      facts({
        conversation: conversation({ lastMentionAt: hoursAgo(2), selfReadThroughAt: hoursAgo(1) }),
      }),
      { mentioned: false },
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(deriveConversation(input)).toMatchObject(expected);
  });

  it("counts unread DMs and groups that mention me toward the badge", () => {
    expect(conversationCountsTowardBadge("dm", { unread: true, mentioned: false })).toBe(true);
    expect(conversationCountsTowardBadge("group", { unread: true, mentioned: false })).toBe(false);
    expect(conversationCountsTowardBadge("group", { unread: true, mentioned: true })).toBe(true);
    expect(conversationCountsTowardBadge("dm", { unread: false, mentioned: false })).toBe(false);
  });

  it("lists the newest first, ties by id", () => {
    const row = (id: string, lastActivityAt: string) => ({ id, lastActivityAt });
    const old = row("b", hoursAgo(8));
    const recent = row("c", hoursAgo(1));
    const tieA = row("a", hoursAgo(3));
    const tieB = row("d", hoursAgo(3));
    expect([old, tieB, recent, tieA].toSorted(compareConversations)).toEqual([
      recent,
      tieA,
      tieB,
      old,
    ]);
  });
});

describe("delegations", () => {
  it.each([
    ["a run that finished after I looked is unseen", hoursAgo(1), hoursAgo(2), true],
    ["a run I saw is not", hoursAgo(1), hoursAgo(1), false],
    ["a running thread has none", null, null, false],
    ["a run before read-all-before is seen", hoursAgo(24 * 8), null, false],
  ] as const)("%s", (_name, runCompletedAt, agentSeenAt, expected) => {
    expect(
      agentUnseen({
        delegation: { agentSeenAt },
        runCompletedAt,
        readAllBefore: hoursAgo(24 * 7),
      }),
    ).toBe(expected);
  });

  it("keeps a v1 topic's item id as the id of the delegation anchored at the topic", () => {
    const key = { channelId: "a", conversationId: "b", anchorMessageId: "c" };
    // The v1 item id was this hash over (channel, conversation, topic id).
    expect(delegationIdFor(key)).toBe("8badde10c760e9b702defb4b");
    expect(delegationIdFor(key)).not.toBe(delegationIdFor({ ...key, anchorMessageId: "d" }));
  });

  it("reads a v1 topic in a DM as its six-hour window, elsewhere as a reply thread", () => {
    const legacy = { scope: null, untilAt: null };
    expect(scopeIsChain(legacy, "group")).toBe(true);
    expect(scopeIsChain(legacy, "topic_group")).toBe(true);
    expect(scopeIsChain(legacy, "dm")).toBe(false);
    expect(rangeUntil(legacy, hoursAgo(10))).toBe(hoursAgo(4));
    expect(scopeIsChain({ scope: "range" }, "group")).toBe(false);
    expect(rangeUntil({ scope: "range", untilAt: hoursAgo(1) }, hoursAgo(10))).toBe(hoursAgo(1));
  });

  it("takes a range from its first message through its end, whatever the page order", () => {
    const at = (id: string, hours: number) => ({
      id,
      createdAt: hoursAgo(hours),
      author: OTHER,
      mentionsSelf: false,
      text: id,
      attachments: [],
      links: [],
    });
    const messages = [at("d", 1), at("c", 2), at("b", 3), at("a", 4)];
    const ids = (until: string | null, anchor = "b") =>
      messagesInRange(messages, anchor, until).map((message) => message.id);
    expect(ids(hoursAgo(2))).toEqual(["b", "c"]);
    expect(ids(null)).toEqual(["b", "c", "d"]);
    expect(ids(null, "missing")).toEqual([]);
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
    const missing = "2 messages in this conversation could not be read and are missing";
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
  it("round-trips reads, delegations, and links", () => {
    const store = new InboxStore(":memory:");
    const key = { channelId: "a", conversationId: "b" };
    store.markConversationRead(key, hoursAgo(1));
    store.pinConversationUnread(key);
    // A stale view moves nothing back.
    store.markConversationRead(key, hoursAgo(3));
    expect(store.listConversationReads("a")).toEqual([
      { ...key, readAt: hoursAgo(1), pinnedUnread: false },
    ]);
    store.pinConversationUnread(key);
    expect(store.readAllBefore("a", hoursAgo(5))).toBe(hoursAgo(5));
    expect(store.readAllBefore("a", hoursAgo(4))).toBe(hoursAgo(5));
    store.markAllRead("a", hoursAgo(0));
    store.markAllRead("a", hoursAgo(2));
    expect(store.readAllBefore("a", hoursAgo(9))).toBe(hoursAgo(0));
    expect(store.listConversationReads("a")[0]?.pinnedUnread).toBe(false);

    const delegation = {
      ...key,
      id: "d1",
      anchorMessageId: "m1",
      scope: "range" as const,
      untilAt: hoursAgo(2),
      preview: "first",
      createdAt: hoursAgo(3),
    };
    store.saveDelegation(delegation);
    store.markAgentSeen("d1", hoursAgo(1));
    store.markAgentSeen("d1", hoursAgo(2));
    // Delegated again: the new range, the first preview and creation time.
    store.saveDelegation({
      ...delegation,
      scope: "chain",
      untilAt: null,
      preview: null,
      createdAt: hoursAgo(0),
    });
    expect(store.listDelegations("a")).toEqual([
      { ...delegation, scope: "chain", untilAt: null, agentSeenAt: hoursAgo(1) },
    ]);

    store.addLink({
      ...key,
      delegationId: "d1",
      threadId: "t1",
      projectId: "p",
      createdAt: hoursAgo(1),
    });
    store.detachLink("d1", "t1", "deleted", hoursAgo(0));
    expect(store.linksForDelegation("d1")).toEqual([
      {
        ...key,
        delegationId: "d1",
        threadId: "t1",
        projectId: "p",
        createdAt: hoursAgo(1),
        detachedAt: hoursAgo(0),
        detachedReason: "deleted",
      },
    ]);
    store.close();
  });

  it("carries v1 topics over: reads per conversation, linked topics as delegations", async () => {
    const file = NodePath.join(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inbox-")),
      "db",
    );
    // Version 2 as the previous build left it.
    const v2 = new NodeSqlite.DatabaseSync(file);
    v2.exec(`CREATE TABLE links (
        item_id TEXT NOT NULL, channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        topic_id TEXT NOT NULL, thread_id TEXT NOT NULL, project_id TEXT NOT NULL,
        created_at TEXT NOT NULL, detached_at TEXT, detached_reason TEXT,
        PRIMARY KEY (item_id, thread_id));
      CREATE INDEX links_by_channel ON links (channel_id, detached_at);
      CREATE TABLE reads (
        channel_id TEXT NOT NULL, conversation_id TEXT NOT NULL, topic_id TEXT NOT NULL,
        read_at TEXT, agent_seen_at TEXT, pinned_unread INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, conversation_id, topic_id));
      CREATE TABLE channel_reads (channel_id TEXT PRIMARY KEY, read_all_before TEXT NOT NULL);
      INSERT INTO reads VALUES ('a', 'b', 'old', '${hoursAgo(1)}', NULL, 0);
      INSERT INTO reads VALUES ('a', 'b', 'other', '${hoursAgo(3)}', '${hoursAgo(2)}', 1);
      INSERT INTO reads VALUES ('a', 'c', 't', NULL, '${hoursAgo(4)}', 0);
      INSERT INTO links VALUES ('item-t', 'a', 'c', 't', 'thread-1', 'p', '${hoursAgo(6)}', '${hoursAgo(5)}', 'replaced');
      INSERT INTO links VALUES ('item-t', 'a', 'c', 't', 'thread-2', 'p', '${hoursAgo(5)}', NULL, NULL);
      PRAGMA user_version = 2;`);
    v2.close();

    const store = new InboxStore(file);
    expect(
      store
        .listConversationReads("a")
        .toSorted((x, y) => x.conversationId.localeCompare(y.conversationId)),
    ).toEqual([
      { channelId: "a", conversationId: "b", readAt: hoursAgo(1), pinnedUnread: true },
      { channelId: "a", conversationId: "c", readAt: null, pinnedUnread: false },
    ]);
    expect(store.listDelegations("a")).toEqual([
      {
        id: "item-t",
        channelId: "a",
        conversationId: "c",
        anchorMessageId: "t",
        scope: null,
        untilAt: null,
        preview: null,
        createdAt: hoursAgo(6),
        agentSeenAt: hoursAgo(4),
      },
    ]);
    expect(store.linksForDelegation("item-t").map((link) => link.threadId)).toEqual([
      "thread-2",
      "thread-1",
    ]);
    store.close();
  });
});

describe("messages", () => {
  const message = (id: string, minute: number, isSelf: boolean, mentionsSelf = false) => ({
    id,
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
