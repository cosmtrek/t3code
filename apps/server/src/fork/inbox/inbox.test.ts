// @effect-diagnostics globalDate:off nodeBuiltinImport:off - Fixed wall-clock timestamps; context folders are temporary directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Artifacts from "./artifacts.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";

import {
  buildContextMarkdown,
  firstMessage,
  mediaFileName,
  parseFallbackDraft,
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
import * as InboxStore from "./store.ts";

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
    [
      "new messages start after the latest mark, my own last message included",
      facts({
        read: seen(hoursAgo(3)),
        conversation: conversation({ lastSelfMessageAt: hoursAgo(2), selfReadThroughAt: "bad" }),
      }),
      { unread: true, readThroughAt: hoursAgo(2) },
    ],
    [
      "the chat app's count holds while T3 has read no further than the chat app",
      facts({
        read: seen(hoursAgo(3)),
        conversation: conversation({ selfReadThroughAt: hoursAgo(3), unreadCount: 4 }),
      }),
      { unread: true, unreadCount: 4 },
    ],
    [
      "the count holds when neither side read it",
      facts({ conversation: conversation({ unreadCount: 4 }) }),
      { unread: true, unreadCount: 4 },
    ],
    [
      "reading further in T3 makes the chat app's count unknown",
      facts({
        read: seen(hoursAgo(2)),
        conversation: conversation({ selfReadThroughAt: hoursAgo(3), unreadCount: 4 }),
      }),
      { unread: true, unreadCount: null },
    ],
    [
      "a T3 read with no chat app read point makes the count unknown",
      facts({ read: seen(hoursAgo(2)), conversation: conversation({ unreadCount: 4 }) }),
      { unread: true, unreadCount: null },
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

    // Replies kept inside a thread come along only with their thread.
    const reply = (id: string, hours: number, rootId: string) => ({
      ...at(id, hours),
      rootId,
      inThread: true,
    });
    const threaded = [...messages, reply("of-a", 2.5, "a"), reply("of-c", 1.5, "c")];
    const within = (anchor: string) =>
      messagesInRange(threaded, anchor, null).map((message) => message.id);
    expect(within("b")).toEqual(["b", "c", "of-c", "d"]);
    expect(within("of-a")).toEqual(["of-a", "c", "of-c", "d"]);
  });
});

describe("delegation text", () => {
  it("puts the user's request after the context, or a default one when blank", () => {
    const text = firstMessage({
      contextDir: "/ctx",
      request: "  Find why sign-in fails  ",
      openUrl: "https://chat.example.com/t/1",
      skippedMessages: 0,
      markdown: false,
    });
    expect(text.split("\n\n").slice(0, 3)).toEqual([
      "Read `/ctx/context.md` for the chat messages and any images.",
      "Find why sign-in fails",
      "Open in app: https://chat.example.com/t/1",
    ]);
    expect(text).toContain("/ctx/draft.md`");
    expect(text).toContain("<draft>");
    const blank = firstMessage({
      contextDir: "/ctx",
      request: " ",
      openUrl: null,
      skippedMessages: 0,
      markdown: false,
    });
    expect(blank).toContain("Do not change anything yet.");
    expect(blank).not.toContain("Open in app");
  });

  it("tells the thread about messages it is not given, and names nameless authors", () => {
    const missing = "2 messages in this conversation could not be read and are missing";
    expect(
      firstMessage({
        contextDir: "/ctx",
        request: "",
        openUrl: null,
        skippedMessages: 2,
        markdown: false,
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
          richSummary: "Forwarded · 1 message",
          attachments: [],
          links: [],
        },
      ],
      images: [],
      senderName: "",
      senderHistory: [],
      openUrl: null,
      skippedMessages: 2,
    });
    expect(markdown.split("\n").slice(0, 3)).toEqual(["# Unknown", "", `${missing} below.`]);
    expect(markdown).toContain(`### Unknown · ${hoursAgo(1)}`);
    // A forward's title comes before the chat it carries.
    expect(markdown).toContain("> Rich content: Forwarded · 1 message\n\nhello");
  });

  it("parses the last tagged draft", () => {
    expect(parseFallbackDraft("<draft>old</draft> text\n<draft>\n new reply \n</draft>")).toBe(
      "new reply",
    );
    expect(parseFallbackDraft("<draft>  </draft> nothing")).toBeNull();
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
  it.effect("round-trips reads, delegations, and links", () =>
    Effect.gen(function* () {
      const store = yield* InboxStore.make(":memory:");
      const key = { channelId: "a", conversationId: "b" };
      yield* store.markConversationRead(key, hoursAgo(1));
      yield* store.pinConversationUnread(key);
      // A stale view moves nothing back.
      yield* store.markConversationRead(key, hoursAgo(3));
      expect(yield* store.listConversationReads("a")).toEqual([
        { ...key, readAt: hoursAgo(1), pinnedUnread: false },
      ]);
      yield* store.pinConversationUnread(key);
      expect(yield* store.readAllBefore("a", hoursAgo(5))).toBe(hoursAgo(5));
      expect(yield* store.readAllBefore("a", hoursAgo(4))).toBe(hoursAgo(5));
      yield* store.markAllRead("a", hoursAgo(0));
      yield* store.markAllRead("a", hoursAgo(2));
      expect(yield* store.readAllBefore("a", hoursAgo(9))).toBe(hoursAgo(0));
      expect((yield* store.listConversationReads("a"))[0]?.pinnedUnread).toBe(false);

      const delegation = {
        ...key,
        id: "d1",
        anchorMessageId: "m1",
        scope: "range" as const,
        untilAt: hoursAgo(2),
        preview: "first",
        createdAt: hoursAgo(3),
      };
      yield* store.saveDelegation(delegation);
      yield* store.markAgentSeen("d1", hoursAgo(1));
      yield* store.markAgentSeen("d1", hoursAgo(2));
      // Delegated again: the new range, the first preview and creation time.
      yield* store.saveDelegation({
        ...delegation,
        scope: "chain",
        untilAt: null,
        preview: null,
        createdAt: hoursAgo(0),
      });
      expect(yield* store.listDelegations("a")).toEqual([
        { ...delegation, scope: "chain", untilAt: null, agentSeenAt: hoursAgo(1), settledAt: null },
      ]);

      yield* store.addLink({
        ...key,
        delegationId: "d1",
        threadId: "t1",
        projectId: "p",
        createdAt: hoursAgo(1),
      });
      yield* store.detachLink("d1", "t1", "deleted", hoursAgo(0));
      expect(yield* store.linksForDelegation("d1")).toEqual([
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
      yield* store.close();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("carries v1 topics over: reads per conversation, linked topics as delegations", () =>
    Effect.gen(function* () {
      const file = NodePath.join(
        yield* Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inbox-"))),
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

      const store = yield* InboxStore.make(file);
      expect(
        (yield* store.listConversationReads("a")).toSorted((x, y) =>
          x.conversationId.localeCompare(y.conversationId),
        ),
      ).toEqual([
        { channelId: "a", conversationId: "b", readAt: hoursAgo(1), pinnedUnread: true },
        { channelId: "a", conversationId: "c", readAt: null, pinnedUnread: false },
      ]);
      expect(yield* store.listDelegations("a")).toEqual([
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
          settledAt: null,
        },
      ]);
      expect((yield* store.linksForDelegation("item-t")).map((link) => link.threadId)).toEqual([
        "thread-2",
        "thread-1",
      ]);
      yield* store.markConversationRead({ channelId: "a", conversationId: "b" }, hoursAgo(0));
      yield* store.setSettled("item-t", hoursAgo(0));
      yield* store.close();
      const reopened = yield* InboxStore.make(file);
      expect(
        (yield* reopened.listConversationReads("a")).find((read) => read.conversationId === "b"),
      ).toEqual({ channelId: "a", conversationId: "b", readAt: hoursAgo(0), pinnedUnread: false });
      expect((yield* reopened.getDelegation("item-t"))?.settledAt).toBe(hoursAgo(0));
      expect((yield* reopened.linksForDelegation("item-t")).map((link) => link.threadId)).toEqual([
        "thread-2",
        "thread-1",
      ]);
      yield* reopened.close();
      const disk = new NodeSqlite.DatabaseSync(file);
      expect(disk.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
      disk.close();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
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
      openUrl: null,
      skippedMessages: 0,
    });
    expect(markdown.indexOf("/ctx/media/first.png")).toBeLessThan(
      markdown.indexOf("/ctx/media/second.png"),
    );
  });
});

const artifactLayer = Artifacts.layer.pipe(Layer.provideMerge(NodeServices.layer));
const folder = Effect.promise(() =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-artifacts-")),
);
const read = (dir: string, file: string) =>
  Effect.promise(() => NodeFSP.readFile(NodePath.join(dir, file), "utf8").catch(() => null));
const write = (dir: string, file: string, text: string) =>
  Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, file), text));

describe("tagged-reply fallback", () => {
  it.effect("lets a later run replace what an earlier run's tags wrote", () =>
    Effect.gen(function* () {
      const files = yield* Artifacts.Artifacts;
      const dir = yield* folder;
      yield* files.applyFallback(dir, "run-1", "first reply");
      yield* files.applyFallback(dir, "run-2", "corrected reply");
      expect(yield* files.readArtifacts(dir)).toEqual({ draft: "corrected reply" });
      yield* write(dir, "draft.md", "edited by the thread\n");
      yield* files.applyFallback(dir, "run-2", "corrected reply");
      expect(yield* read(dir, "draft.md")).toBe("edited by the thread\n");
    }).pipe(Effect.provide(artifactLayer)),
  );

  it.effect("never replaces a file the thread wrote itself", () =>
    Effect.gen(function* () {
      const files = yield* Artifacts.Artifacts;
      const dir = yield* folder;
      yield* write(dir, "draft.md", "from the file\n");
      yield* files.applyFallback(dir, "run-1", "from tags");
      expect(yield* files.readArtifacts(dir)).toEqual({ draft: "from the file" });
      const owned = yield* folder;
      yield* files.applyFallback(owned, "run-1", "tagged");
      yield* write(owned, "draft.md", "rewritten\n");
      yield* files.applyFallback(owned, "run-2", "newer tags");
      expect(yield* read(owned, "draft.md")).toBe("rewritten\n");
    }).pipe(Effect.provide(artifactLayer)),
  );

  it.effect("keeps a thread's write that lands while the fallback is writing", () =>
    Effect.gen(function* () {
      const files = yield* Artifacts.Artifacts;
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* folder;
      yield* files.applyFallback(dir, "run-1", "from tags", {
        beforeWrite: (file) => write(dir, file, "thread wrote\n"),
      });
      expect(yield* read(dir, "draft.md")).toBe("thread wrote\n");
      yield* write(dir, "draft.md", "x\n");
      const owned = yield* folder;
      yield* files.applyFallback(owned, "run-1", "first");
      yield* files.applyFallback(owned, "run-2", "second", {
        beforeWrite: (file) => write(owned, file, "thread wrote\n"),
      });
      expect(yield* read(owned, "draft.md")).toBe("thread wrote\n");
      expect((yield* fs.readDirectory(owned)).filter((file) => file.includes(".aside"))).toEqual(
        [],
      );
    }).pipe(Effect.provide(artifactLayer)),
  );

  it.effect("restores the original draft when replacement fails after moving it aside", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* folder;
      let failed = false;
      const injected = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "writeFile",
        pathOrDescriptor: dir,
        cause: Object.assign(new Error("injected write failure"), { code: "EIO" }),
      });
      const files = yield* Artifacts.Artifacts.pipe(
        Effect.provide(Artifacts.layer),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.FileSystem.of({
            ...fs,
            writeFileString: (file, text, options) =>
              Effect.suspend(() => {
                if (
                  file === NodePath.join(dir, "draft.md") &&
                  text === "replacement\n" &&
                  !failed
                ) {
                  failed = true;
                  return Effect.fail(injected);
                }
                return fs.writeFileString(file, text, options);
              }),
          }),
        ),
      );
      yield* files.applyFallback(dir, "run-1", "original reply");
      const error = yield* Effect.flip(files.applyFallback(dir, "run-2", "replacement"));
      expect(error.reason.cause).toMatchObject({ code: "EIO" });
      expect(failed).toBe(true);
      expect(yield* read(dir, "draft.md")).toBe("original reply\n");
      expect((yield* fs.readDirectory(dir)).filter((name) => name.endsWith(".aside"))).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("applies one run once when two reads race, and the next run still updates", () =>
    Effect.gen(function* () {
      const files = yield* Artifacts.Artifacts;
      const dir = yield* folder;
      yield* files.applyFallback(dir, "run-1", "one");
      const queued = yield* Deferred.make<void>();
      let other: Fiber.Fiber<void, PlatformError.PlatformError> | undefined;
      yield* files.applyFallback(dir, "run-2", "two", {
        beforeWrite: () =>
          Effect.gen(function* () {
            other = yield* files
              .applyFallback(dir, "run-2", "two", {
                onQueued: () => {
                  Deferred.doneUnsafe(queued, Effect.void);
                },
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(queued);
          }),
      });
      if (other === undefined) throw new Error("The competing fallback was not started.");
      yield* Fiber.join(other);
      expect(yield* read(dir, "draft.md")).toBe("two\n");
      yield* files.applyFallback(dir, "run-3", "three");
      expect(yield* read(dir, "draft.md")).toBe("three\n");
    }).pipe(Effect.provide(artifactLayer)),
  );
});

describe("sent records", () => {
  it.effect("keeps both of two sends made in the same millisecond", () =>
    Effect.gen(function* () {
      const files = yield* Artifacts.Artifacts;
      const itemDir = yield* folder;
      const sentAt = "2026-11-14T12:00:00.000Z";
      for (const [messageId, text] of [
        ["m-1", "first"],
        ["m-2", "second"],
      ] as const) {
        yield* files.recordSent({
          itemDir,
          draftDir: null,
          draftAtSend: null,
          text,
          messageId,
          sentAt,
        });
      }
      expect((yield* files.readSent(itemDir)).map((record) => record.text).toSorted()).toEqual([
        "first",
        "second",
      ]);
    }).pipe(Effect.provide(artifactLayer)),
  );
});

describe("discarding a draft", () => {
  it.effect("drops the draft the user saw and keeps one the thread rewrote since", () =>
    Effect.gen(function* () {
      const files = yield* Artifacts.Artifacts;
      const dir = yield* folder;
      const at = "2026-11-16T12:00:00.000Z";
      yield* write(dir, "draft.md", "newer reply\n");
      expect(yield* files.discardDraft(dir, "older reply", at)).toBe(false);
      expect((yield* files.readArtifacts(dir)).draft).toBe("newer reply");
      expect(yield* files.discardDraft(dir, "newer reply", at)).toBe(true);
      expect((yield* files.readArtifacts(dir)).draft).toBeNull();
    }).pipe(Effect.provide(artifactLayer)),
  );
});
