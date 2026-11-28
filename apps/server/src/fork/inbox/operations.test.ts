// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Drives the inbox against temporary folders and a fake adapter.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as Project from "../../project/ProjectService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ChannelHub } from "../channels/hub.ts";
import type { AdapterRequest, AdapterResponse } from "../channels/transport.ts";
import { threadContextDir } from "./artifacts.ts";
import { delegationIdFor } from "./derive.ts";
import { InboxRuntime } from "./InboxRuntime.ts";
import { followLinkedThreads } from "./linkedThreads.ts";
import * as Inbox from "./operations.ts";
import { InboxStore } from "./store.ts";

const TOKEN = "secret-token";
const encoder = new TextEncoder();
const json = (status: number, value: unknown): AdapterResponse => ({
  status,
  contentType: "application/json",
  body: encoder.encode(JSON.stringify(value)),
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 8, minute)).toISOString();
const ME = { id: "me", name: "Me", isSelf: true };
const THEM = { id: "u2", name: "Jordan", isSelf: false };

interface FakeMessage {
  readonly id: string;
  readonly minute: number;
  readonly author: typeof ME | typeof THEM;
  readonly mentionsSelf?: boolean;
  readonly image?: { readonly key: string; readonly name: string };
  /** The message this one answers. */
  readonly replyTo?: string;
  readonly reactions?: ReadonlyArray<unknown>;
}

interface FakeConversation {
  readonly id: string;
  readonly kind?: "dm" | "group" | "topic_group";
  readonly messages: ReadonlyArray<FakeMessage>;
  /** Where the chat app shows I read through. */
  readonly readThroughMinute?: number;
}

/** An adapter that serves one item per page, so every list takes several requests. */
function fakeAdapter(
  conversations: () => ReadonlyArray<FakeConversation>,
  sendAnswer: () => AdapterResponse,
  config: Record<string, unknown>,
) {
  const paged = (items: ReadonlyArray<unknown>, url: URL) => {
    const index = Number(url.searchParams.get("cursor") ?? "0");
    return json(200, {
      items: items.slice(index, index + 1),
      nextCursor: index + 1 < items.length ? String(index + 1) : null,
    });
  };
  const rootOf = (conversation: FakeConversation, message: FakeMessage): string => {
    const parent = conversation.messages.find((candidate) => candidate.id === message.replyTo);
    return parent ? rootOf(conversation, parent) : message.id;
  };
  const messageJson = (conversation: FakeConversation, message: FakeMessage) => {
    const root = rootOf(conversation, message);
    return {
      id: message.id,
      createdAt: at(message.minute),
      rootId: root === message.id ? null : root,
      replyTo:
        message.replyTo === undefined
          ? null
          : { id: message.replyTo, authorName: null, preview: null },
      author: message.author,
      mentionsSelf: message.mentionsSelf ?? false,
      text: `text of ${message.id}`,
      attachments: message.image ? [{ ...message.image, kind: "image" }] : [],
      links: [],
      reactions: message.reactions ?? null,
    };
  };
  const timeOf = (message: FakeMessage | undefined) => (message ? at(message.minute) : null);
  const summary = (conversation: FakeConversation) => {
    const sorted = conversation.messages.toSorted((a, b) => a.minute - b.minute);
    const last = sorted.at(-1);
    const others = sorted.filter((message) => !message.author.isSelf);
    return {
      id: conversation.id,
      kind: conversation.kind ?? "group",
      name: conversation.id,
      lastActivityAt: timeOf(last) ?? at(0),
      relevant: true,
      muted: false,
      lastMessage: last
        ? { id: last.id, createdAt: at(last.minute), author: last.author, preview: last.id }
        : null,
      lastOtherMessageAt: timeOf(others.at(-1)),
      lastSelfMessageAt: timeOf(sorted.findLast((message) => message.author.isSelf)),
      lastMentionAt: timeOf(sorted.findLast((message) => message.mentionsSelf === true)),
      selfReadThroughAt:
        conversation.readThroughMinute === undefined
          ? null
          : timeOf(others.findLast((message) => message.minute <= conversation.readThroughMinute!)),
    };
  };
  return (request: AdapterRequest): AdapterResponse => {
    const url = new URL(request.path, "http://adapter.invalid");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "POST") return sendAnswer();
    if (url.pathname === "/health") {
      return json(200, {
        protocol: 2,
        adapterVersion: "1",
        online: true,
        loggedIn: true,
        lastSyncAt: at(0),
        self: { id: "me", name: "Me" },
      });
    }
    if (url.pathname === "/config") {
      return json(200, {
        displayName: "Chat",
        defaultProjectPaths: ["~/code/somewhere"],
        relevanceSummary: "All",
        ...config,
      });
    }
    const all = conversations();
    if (parts.length === 1 && parts[0] === "conversations") {
      return paged(
        all.map(summary).toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt)),
        url,
      );
    }
    const conversation = all.find((candidate) => candidate.id === parts[1]);
    if (conversation && parts[2] === "messages") {
      const root = url.searchParams.get("root");
      // Newest first, as some adapters page: the inbox must sort before reading.
      const messages = conversation.messages
        .filter((message) => root === null || rootOf(conversation, message) === root)
        .toSorted((a, b) => b.minute - a.minute)
        .map((message) => messageJson(conversation, message));
      return paged(messages, url);
    }
    return json(404, { error: { code: "unknown", message: "Not found" } });
  };
}

let channelCounter = 0;

interface Harness {
  readonly channelId: string;
  /** Every path asked of the adapter. */
  readonly requests: string[];
  /** Every JSON body posted to the adapter. */
  readonly posted: unknown[];
  /** The size of every file posted to the adapter. */
  readonly uploaded: number[];
  /** While set, conversation listings wait for it. */
  holdListings: Promise<void> | null;
  readonly runtime: InboxRuntime["Service"];
  readonly shells: Map<string, OrchestrationV2ThreadShell | null>;
  /** Every thread the inbox asked to settle. */
  readonly settledThreads: string[];
  readonly layer: Layer.Layer<
    InboxRuntime | ThreadManagement.ThreadManagementService | Project.ProjectService
  >;
  readonly keyOf: (conversationId: string) => {
    readonly channelId: string;
    readonly conversationId: string;
  };
}

async function harness(
  conversations: () => ReadonlyArray<FakeConversation>,
  sendAnswer: () => AdapterResponse = () => json(200, { messageId: "sent-1" }),
  config: Record<string, unknown> = {},
  seedReadCutoff = true,
): Promise<Harness> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-inbox-"));
  const tokenFile = NodePath.join(dir, "token");
  await NodeFSP.writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const handle = fakeAdapter(conversations, sendAnswer, config);
  const requests: string[] = [];
  const posted: unknown[] = [];
  const uploaded: number[] = [];
  const control: { holdListings: Promise<void> | null } = { holdListings: null };
  const hub = new ChannelHub({
    configPath: NodePath.join(dir, "channels.json"),
    transportFor: () => ({
      request: async (request) => {
        requests.push(request.path);
        if (control.holdListings !== null && request.path.startsWith("/conversations?")) {
          await control.holdListings;
        }
        if (request.bytes !== undefined) uploaded.push(request.bytes.byteLength);
        else if (request.method === "POST") posted.push(request.body);
        return handle(request);
      },
      events: () => new Promise(() => undefined),
    }),
    background: false,
  });
  await hub.start();
  channelCounter += 1;
  const channelId = `chat-${channelCounter}`;
  await hub.save(
    {
      id: channelId,
      kind: "http-adapter",
      name: "Chat",
      baseUrl: "http://127.0.0.1:7341",
      tokenFile,
      enabled: true,
    },
    { create: true },
  );
  const store = new InboxStore(":memory:");
  // Fixtures are at fixed past times; none should fall before the first-read cutoff.
  if (seedReadCutoff) store.readAllBefore(channelId, "2026-01-01T00:00:00.000Z");
  const runtime = {
    hub,
    store,
    channelsDir: dir,
    itemsDir: NodePath.join(dir, "items"),
    subscribe: (listener: Parameters<ChannelHub["subscribe"]>[0]) => hub.subscribe(listener),
  };
  const shells = new Map<string, OrchestrationV2ThreadShell | null>();
  const settledThreads: string[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(InboxRuntime, runtime),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      getThreadRecords: () => Effect.succeed({ messages: [] } as never),
      settleThread: ({ threadId }) =>
        Effect.sync(() => {
          settledThreads.push(threadId);
          return { sequence: settledThreads.length };
        }),
    }),
    Layer.mock(Project.ProjectService)({ listShells: () => Effect.succeed([]) }),
  );
  return {
    settledThreads,
    channelId,
    requests,
    posted,
    uploaded,
    get holdListings() {
      return control.holdListings;
    },
    set holdListings(hold) {
      control.holdListings = hold;
    },
    runtime,
    shells,
    layer,
    keyOf: (conversationId) => ({ channelId, conversationId }),
  };
}

const idleShell = (threadId: string) =>
  ({
    id: threadId,
    title: "Thread",
    archivedAt: null,
    deletedAt: null,
    activeRunId: null,
    status: "idle",
    latestRunId: null,
    latestRunCompletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

/** Saves a delegation anchored at `anchorMessageId`; null scope is one made from a v1 topic. */
const saveDelegation = (
  h: Harness,
  conversationId: string,
  anchorMessageId: string,
  scope: "chain" | "range" | null = "chain",
) => {
  const key = { ...h.keyOf(conversationId), anchorMessageId };
  const id = delegationIdFor(key);
  if (h.runtime.store.getDelegation(id) === null) {
    h.runtime.store.saveDelegation({
      ...key,
      id,
      scope,
      untilAt: null,
      preview: null,
      createdAt: at(0),
    });
    // As a delegation publishes once saved.
    h.runtime.hub.invalidate(h.channelId);
  }
  return id;
};

const linkThread = (
  h: Harness,
  conversationId: string,
  anchorMessageId: string,
  threadId: string,
  minute: number,
  scope: "chain" | "range" | null = "chain",
) =>
  Effect.promise(async () => {
    const delegationId = saveDelegation(h, conversationId, anchorMessageId, scope);
    h.runtime.store.addLink({
      ...h.keyOf(conversationId),
      delegationId,
      threadId,
      projectId: "p",
      createdAt: at(minute),
    });
    h.shells.set(threadId, idleShell(threadId));
    const dir = threadContextDir(h.runtime.itemsDir, delegationId, threadId);
    await NodeFSP.mkdir(dir, { recursive: true });
    return { dir, delegationId };
  });

const delegationQuery = (h: Harness, delegationId: string) =>
  new URLSearchParams({ channelId: h.channelId, delegationId });

const listOf = (h: Harness) => Inbox.listInbox(h.channelId).pipe(Effect.provide(h.layer));

const launchLayer = (h: Harness, launched: Array<ThreadLaunch.ThreadLaunchInput>) =>
  Layer.mergeAll(
    h.layer,
    Layer.mock(Project.ProjectService)({
      listShells: () =>
        Effect.succeed([
          { id: "p", title: "p", workspaceRoot: "/code/p", archivedAt: null },
        ] as never),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.succeed(ServerConfig.ServerConfig, {} as never),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (input) => {
        launched.push(input);
        return Effect.succeed({ threadId: input.threadId } as never);
      },
    }),
    Layer.mock(DocumentText.DocumentText)({}),
    FileSystem.layerNoop({}),
  );

describe("inbox listing", () => {
  it.effect("uses the clock for the seven-day first-read cutoff and ten-second memo TTL", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-21T08:10:00.000Z")),
      );
      const h = yield* Effect.promise(() =>
        harness(
          () => [
            { id: "old", messages: [{ id: "old-1", minute: 9, author: THEM }] },
            { id: "new", messages: [{ id: "new-1", minute: 11, author: THEM }] },
          ],
          undefined,
          {},
          false,
        ),
      );
      const read = Inbox.readChannel(h.channelId).pipe(Effect.provide(h.layer));
      const first = yield* read;
      expect(h.runtime.store.readAllBefore(h.channelId, "unused")).toBe("2026-11-14T08:10:00.000Z");
      const listed = yield* listOf(h);
      expect(listed.conversations.find((row) => row.id === "old")?.unread).toBe(false);
      expect(listed.conversations.find((row) => row.id === "new")?.unread).toBe(true);
      yield* TestClock.adjust(9_999);
      expect(yield* read).toBe(first);
      yield* TestClock.adjust(1);
      expect(yield* read).not.toBe(first);
      expect(h.runtime.store.readAllBefore(h.channelId, "unused")).toBe("2026-11-14T08:10:00.000Z");
    }),
  );

  it.effect("lists one row per conversation and reads every page", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [
          { id: "c-first", messages: [{ id: "a1", minute: 1, author: THEM }] },
          {
            id: "c-second",
            messages: [
              { id: "j1", minute: 1, author: ME },
              { id: "j2", minute: 2, author: THEM, replyTo: "j1" },
              { id: "j3", minute: 3, author: THEM, replyTo: "j2" },
              { id: "j4", minute: 4, author: THEM, mentionsSelf: true },
              { id: "s1", minute: 5, author: THEM, image: { key: "k", name: "same.png" } },
              { id: "s2", minute: 6, author: ME },
            ],
          },
          {
            id: "c-read-there",
            readThroughMinute: 2,
            messages: [{ id: "r1", minute: 2, author: THEM }],
          },
        ]),
      );
      const result = yield* listOf(h);
      expect(result.conversations.map((row) => row.id)).toEqual([
        "c-second",
        "c-read-there",
        "c-first",
      ]);
      const byId = new Map(result.conversations.map((row) => [row.id, row] as const));
      // My last message reads it; the mention before it is answered.
      expect(byId.get("c-second")).toMatchObject({ unread: false, mentioned: false });
      expect(byId.get("c-first")).toMatchObject({ unread: true, mentioned: false });
      // Read in the chat app.
      expect(byId.get("c-read-there")).toMatchObject({ unread: false });
      expect(h.requests.some((path) => path.includes("/topics"))).toBe(false);

      // The chat view reads one page at a time, newest page first, and pages back by cursor.
      const conversation = (cursor?: string) =>
        Inbox.readConversation(
          new URLSearchParams({
            channelId: h.channelId,
            conversationId: "c-second",
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ).pipe(Effect.provide(h.layer));
      const newest = yield* conversation();
      expect(newest.messages.map((message) => message.id)).toEqual(["s2"]);
      expect(newest.nextCursor).toBe("1");
      const older = yield* conversation(newest.nextCursor!);
      expect(older.messages.map((message) => message.id)).toEqual(["s1"]);
      expect(h.requests.filter((path) => path.includes("order=desc"))).toHaveLength(2);

      // A delegation reads its whole reply thread, every page, oldest first.
      const delegationId = saveDelegation(h, "c-second", "j1");
      const detail = yield* Inbox.readDelegation(delegationQuery(h, delegationId)).pipe(
        Effect.provide(h.layer),
      );
      expect(detail.messages.map((message) => message.id)).toEqual(["j1", "j2", "j3"]);
      expect(detail).toMatchObject({ complete: true, rootMissing: false });
    }),
  );

  it.effect(
    "reads a conversation up to what the client saw, and unreads it on a newer message",
    () =>
      Effect.gen(function* () {
        const messages: FakeMessage[] = [{ id: "m1", minute: 1, author: THEM }];
        const h = yield* Effect.promise(() => harness(() => [{ id: "c", kind: "dm", messages }]));
        const key = h.keyOf("c");
        const row = () => listOf(h).pipe(Effect.map((result) => result.conversations[0]));
        h.requests.length = 0;
        yield* Inbox.setRead({ ...key, read: true, lastMessageAt: at(1) }).pipe(
          Effect.provide(h.layer),
        );
        expect(h.requests).toEqual([]);
        expect(yield* row()).toMatchObject({ unread: false });
        messages.push({ id: "m2", minute: 2, author: THEM });
        h.runtime.hub.invalidate(h.channelId);
        expect(yield* row()).toMatchObject({ unread: true });
        // An unread DM counts toward the badge, and the sidebar lists it.
        const summary = () =>
          Inbox.overview().pipe(
            Effect.map((overview) =>
              overview.channels.find((channel) => channel.id === h.channelId),
            ),
            Effect.provide(h.layer),
          );
        const badge = () => summary().pipe(Effect.map((channel) => channel?.unreadCount));
        expect(yield* badge()).toBe(1);
        expect((yield* summary())?.attention?.conversations.map(({ id }) => id)).toEqual([
          key.conversationId,
        ]);
        yield* Inbox.setRead({ ...key, read: true, lastMessageAt: at(2) }).pipe(
          Effect.provide(h.layer),
        );
        yield* Inbox.setRead({ ...key, read: false }).pipe(Effect.provide(h.layer));
        expect(yield* row()).toMatchObject({ unread: true });
        yield* Inbox.markAllRead({ channelId: h.channelId, before: at(2) }).pipe(
          Effect.provide(h.layer),
        );
        expect(yield* row()).toMatchObject({ unread: false });
        expect(yield* badge()).toBe(0);
        expect((yield* summary())?.attention?.conversations).toEqual([]);
      }),
  );

  it.effect("shows a finished run until the client reports seeing it", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [{ id: "c", messages: [{ id: "m1", minute: 1, author: ME }] }]),
      );
      const { delegationId } = yield* linkThread(h, "c", "m1", "thread-1", 1);
      const finished = (status: string, extra: Record<string, unknown> = {}) => {
        h.shells.set("thread-1", {
          ...idleShell("thread-1"),
          status,
          latestRunId: "run-1",
          latestRunCompletedAt: DateTime.makeUnsafe(at(5)),
          ...extra,
        } as never);
        h.runtime.hub.invalidate(h.channelId);
      };
      const item = () => listOf(h).pipe(Effect.map((result) => result.delegations[0]));
      finished("completed");
      expect(yield* item()).toMatchObject({
        id: delegationId,
        agentUnseen: true,
        thread: { runCompletedAt: at(5) },
      });
      const quietRuns: ReadonlyArray<[string, Record<string, unknown>]> = [
        ["rolled_back", {}],
        ["cancelled", {}],
        ["completed", { latestRunBackgroundWake: true }],
        ["interrupted", { latestRunStopRequested: true }],
      ];
      for (const [status, extra] of quietRuns) {
        finished(status, extra);
        expect(yield* item()).toMatchObject({ agentUnseen: false });
      }
      finished("failed");
      yield* Inbox.markSeen({ channelId: h.channelId, delegationId, runCompletedAt: at(5) }).pipe(
        Effect.provide(h.layer),
      );
      expect(yield* item()).toMatchObject({ agentUnseen: false });
    }),
  );

  it.effect(
    "settling drops a delegation's signals and settles its thread; delegating reopens it",
    () =>
      Effect.gen(function* () {
        const h = yield* Effect.promise(() =>
          harness(() => [{ id: "c", messages: [{ id: "m1", minute: 1, author: THEM }] }]),
        );
        const { dir, delegationId } = yield* linkThread(h, "c", "m1", "thread-1", 1);
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "Fixed.\n"));
        h.shells.set("thread-1", {
          ...idleShell("thread-1"),
          status: "completed",
          latestRunId: "run-1",
          latestRunCompletedAt: DateTime.makeUnsafe(at(5)),
        } as never);
        const item = () => listOf(h).pipe(Effect.map((result) => result.delegations[0]));
        expect(yield* item()).toMatchObject({ agentUnseen: true, hasDraft: true, settledAt: null });

        yield* Inbox.settle({ channelId: h.channelId, delegationId, settled: true }).pipe(
          Effect.provide(h.layer),
        );
        expect(yield* item()).toMatchObject({ agentUnseen: false, hasDraft: false, thread: null });
        expect((yield* item())?.settledAt).not.toBeNull();
        expect(h.settledThreads).toEqual(["thread-1"]);
        // Opening it still shows its thread.
        const opened = yield* Inbox.readDelegation(delegationQuery(h, delegationId)).pipe(
          Effect.provide(h.layer),
        );
        expect(opened.delegation.thread?.threadId).toBe("thread-1");

        yield* Inbox.settle({ channelId: h.channelId, delegationId, settled: false }).pipe(
          Effect.provide(h.layer),
        );
        expect(yield* item()).toMatchObject({ settledAt: null, hasDraft: true });

        yield* Inbox.settle({ channelId: h.channelId, delegationId, settled: true }).pipe(
          Effect.provide(h.layer),
        );
        const key = { ...h.keyOf("c"), anchorMessageId: "m1" };
        h.runtime.store.saveDelegation({
          ...key,
          id: delegationId,
          scope: "chain",
          untilAt: null,
          preview: null,
          createdAt: at(9),
        });
        expect(h.runtime.store.getDelegation(delegationId)?.settledAt).toBeNull();
      }),
  );

  it.effect("shares one read of the channel until something in it changes", () =>
    Effect.gen(function* () {
      const messages: FakeMessage[] = [{ id: "m1", minute: 1, author: THEM }];
      const h = yield* Effect.promise(() => harness(() => [{ id: "c", messages }]));
      const delegationId = saveDelegation(h, "c", "m1");
      const reads = vi.spyOn(h.runtime.store, "listConversationReads");
      yield* Effect.all(
        [
          Inbox.overview(),
          Inbox.listInbox(h.channelId),
          Inbox.readDelegation(delegationQuery(h, delegationId)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(h.layer));
      expect(reads).toHaveBeenCalledTimes(1);
      yield* Inbox.setRead({ ...h.keyOf("c"), read: true, lastMessageAt: at(1) }).pipe(
        Effect.provide(h.layer),
      );
      const result = yield* listOf(h);
      expect(reads).toHaveBeenCalledTimes(2);
      expect(result.conversations[0]).toMatchObject({ unread: false });
    }),
  );

  it.effect("answers the overview before a slow listing, then announces the count", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [{ id: "c", kind: "dm", messages: [{ id: "m1", minute: 1, author: THEM }] }]),
      );
      let release = () => {};
      h.holdListings = new Promise<void>((resolve) => {
        release = resolve;
      });
      const announced = yield* Deferred.make<void>();
      const stop = h.runtime.hub.subscribe((event) => {
        if (event.type === "counts" && event.channelId === h.channelId) {
          Deferred.doneUnsafe(announced, Effect.void);
        }
      });
      const overview = yield* Inbox.overview().pipe(Effect.provide(h.layer), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const early = yield* Fiber.join(overview);
      expect(early.channels.find((channel) => channel.id === h.channelId)?.unreadCount).toBeNull();
      release();
      yield* Deferred.await(announced);
      stop();
      const listings = h.requests.filter((path) => path.startsWith("/conversations?")).length;
      const later = yield* Inbox.overview().pipe(Effect.provide(h.layer));
      expect(later.channels.find((channel) => channel.id === h.channelId)?.unreadCount).toBe(1);
      // The announcement reuses the read that landed instead of starting another.
      expect(h.requests.filter((path) => path.startsWith("/conversations?"))).toHaveLength(
        listings,
      );
    }),
  );

  it.effect("says when the channel lists more conversations than it reads", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() =>
          Array.from({ length: 21 }, (_, index) => ({
            id: `c${index}`,
            messages: [{ id: `m${index}`, minute: 1, author: THEM }],
          })),
        ),
      );
      const result = yield* listOf(h);
      expect(result.conversations).toHaveLength(20);
      expect(result.truncatedAtPages).toBe(20);
    }),
  );

  it.effect("reads a delegation made from a v1 DM topic as its six-hour window", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [
          {
            id: "c",
            kind: "dm",
            messages: [
              { id: "before", minute: 0, author: THEM },
              { id: "anchor", minute: 1, author: THEM },
              { id: "inside", minute: 300, author: ME },
              { id: "after", minute: 1_000, author: THEM },
            ],
          },
        ]),
      );
      const delegationId = saveDelegation(h, "c", "anchor", null);
      const detail = yield* Inbox.readDelegation(delegationQuery(h, delegationId)).pipe(
        Effect.provide(h.layer),
      );
      expect(detail.messages.map((message) => message.id)).toEqual(["anchor", "inside"]);
    }),
  );
});

describe("delegating", () => {
  it.effect("offers the project the delegation's last thread used", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [{ id: "c", messages: [{ id: "m1", minute: 1, author: THEM }] }]),
      );
      yield* linkThread(h, "c", "m1", "thread-1", 1);
      h.runtime.store.addLink({
        ...h.keyOf("c"),
        delegationId: delegationIdFor({ ...h.keyOf("c"), anchorMessageId: "m1" }),
        threadId: "thread-2",
        projectId: "p-second",
        createdAt: at(2),
      });
      h.shells.set("thread-2", {
        ...idleShell("thread-2"),
        worktreePath: "/code/p-second-worktree",
      } as OrchestrationV2ThreadShell);
      const project = (id: string) => ({
        id,
        title: id,
        workspaceRoot: `/code/${id}`,
        archivedAt: null,
      });
      const options = yield* Inbox.delegateOptions(
        new URLSearchParams({ ...h.keyOf("c"), anchorMessageId: "m1" }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            h.layer,
            Layer.mock(Project.ProjectService)({
              listShells: () => Effect.succeed([project("p-first"), project("p-second")] as never),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.fail("no settings" as never),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          ),
        ),
      );
      expect(options).toMatchObject({ scope: "chain", defaultProjectId: "p-second" });
      // The last thread's checkout, so another thread continues where it worked.
      expect(options.defaultWorkspaceStrategy).toEqual({
        type: "existing_worktree",
        worktreePath: "/code/p-second-worktree",
      });
    }),
  );

  it.effect("starts the thread in the checkout asked for, the project's when none is", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [
          {
            id: "c",
            messages: ["root", "worktree", "bad"].map((id, index) => ({
              id,
              minute: index,
              author: THEM,
            })),
          },
        ]),
      );
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const delegate = (anchorMessageId: string, workspaceStrategy?: unknown) =>
        Inbox.delegate({
          ...h.keyOf("c"),
          anchorMessageId,
          scope: "chain",
          projectId: "p",
          modelSelection: { instanceId: "codex", model: "gpt" },
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
        }).pipe(Effect.provide(launchLayer(h, launched)));

      yield* delegate("root");
      const worktree = { type: "worktree", baseRef: "main", startFromOrigin: true };
      const second = yield* delegate("worktree", worktree);
      expect(launched.map((input) => input.workspaceStrategy)).toEqual([
        { type: "root" },
        worktree,
      ]);
      const request = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(
            threadContextDir(h.runtime.itemsDir, second.delegationId, launched[1]!.threadId!),
            "request.json",
          ),
          "utf8",
        ),
      );
      expect(JSON.parse(request).workspaceStrategy).toEqual(worktree);

      const error = yield* delegate("bad", { type: "worktree" }).pipe(Effect.flip);
      expect(error).toMatchObject({ status: 400, field: "workspaceStrategy" });
      expect(launched).toHaveLength(2);
    }),
  );

  it.effect("gives the thread the reply thread, or the range asked for, and nothing else", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(
          () => [
            {
              id: "c",
              messages: [
                { id: "root", minute: 1, author: THEM },
                {
                  id: "aside",
                  minute: 2,
                  author: THEM,
                  reactions: [{ key: "OK", emoji: null, count: 1, users: [], includesSelf: true }],
                },
                { id: "reply", minute: 3, author: ME, replyTo: "root" },
                { id: "late", minute: 4, author: THEM },
                { id: "ask", minute: 5, author: THEM, replyTo: "root" },
              ],
            },
          ],
          undefined,
          { ackReaction: "OK" },
        ),
      );
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const delegate = (input: Record<string, unknown>) =>
        Inbox.delegate({ ...h.keyOf("c"), projectId: "p", ...input }).pipe(
          Effect.provide(launchLayer(h, launched)),
        );
      const contextOf = (result: { delegationId: string; threadId: string }) =>
        Effect.promise(() =>
          NodeFSP.readFile(
            NodePath.join(
              threadContextDir(h.runtime.itemsDir, result.delegationId, result.threadId),
              "context.md",
            ),
            "utf8",
          ),
        );
      const mentioned = (context: string) =>
        ["root", "aside", "reply", "late", "ask"].filter((id) =>
          context.includes(`text of ${id}\n`),
        );
      const modelSelection = { instanceId: "codex", model: "gpt" };

      const chain = yield* delegate({
        anchorMessageId: "root",
        pickedMessageId: "ask",
        scope: "chain",
        modelSelection,
      });
      expect(mentioned(yield* contextOf(chain))).toEqual(["root", "reply", "ask"]);

      const range = yield* delegate({
        anchorMessageId: "aside",
        scope: "range",
        untilMessageId: "reply",
        modelSelection,
      });
      expect(mentioned(yield* contextOf(range))).toEqual(["aside", "reply"]);
      expect(h.runtime.store.getDelegation(range.delegationId)).toMatchObject({
        scope: "range",
        untilAt: at(3),
        preview: "text of aside",
      });
      // Read again later, the range stays where it was delegated.
      const detail = yield* Inbox.readDelegation(delegationQuery(h, range.delegationId)).pipe(
        Effect.provide(h.layer),
      );
      expect(detail.messages.map((message) => message.id)).toEqual(["aside", "reply"]);

      const backwards = yield* delegate({
        anchorMessageId: "reply",
        scope: "range",
        untilMessageId: "aside",
        modelSelection,
      }).pipe(Effect.flip);
      expect(backwards).toMatchObject({ status: 400, field: "untilMessageId" });

      yield* delegate({ anchorMessageId: "reply", scope: "range", modelSelection });
      // The picked message gets the reaction, the sender's first when it is mine, never a second.
      expect(h.posted).toEqual([
        { conversationId: "c", messageId: "ask", key: "OK" },
        { conversationId: "c", messageId: "late", key: "OK" },
      ]);
    }),
  );

  it.effect.each([
    [
      "a reply thread longer than the pages it reads",
      "chain",
      Array.from({ length: 51 }, (_, index) => ({
        id: `m${index}`,
        minute: index,
        author: THEM,
        ...(index === 0 ? {} : { replyTo: "m0" }),
      })),
    ],
    [
      "a range starting further back than it reads",
      "range",
      Array.from({ length: 21 }, (_, index) => ({ id: `m${index}`, minute: index, author: THEM })),
    ],
  ] as const)("refuses %s, before starting anything", ([_name, scope, messages]) =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(() => [{ id: "c", kind: "dm", messages }]));
      const error = yield* Inbox.delegate({
        ...h.keyOf("c"),
        anchorMessageId: "m0",
        scope,
        projectId: "p",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            h.layer,
            // Refused before any of these is used.
            Layer.mock(ServerSettings.ServerSettingsService)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            Layer.succeed(ServerConfig.ServerConfig, {} as never),
            Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
            Layer.mock(DocumentText.DocumentText)({}),
            FileSystem.layerNoop({}),
          ),
        ),
        Effect.flip,
      );
      expect(error.code).toBe("scope_too_long");
      expect(h.runtime.store.listLinks(h.channelId)).toEqual([]);
      expect(h.runtime.store.listDelegations(h.channelId)).toEqual([]);
    }),
  );
});

describe("linked threads and their files", () => {
  const oneConversation = (): ReadonlyArray<FakeConversation> => [
    { id: "c", kind: "dm", messages: [{ id: "m1", minute: 1, author: THEM }] },
  ];

  it.effect("shows only the current thread's draft, whatever an older thread writes", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneConversation));
      const old = yield* linkThread(h, "c", "m1", "thread-old", 1);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(old.dir, "draft.md"), "old\n"));
      // A second delegation replaced the first.
      h.runtime.store.detachLink(old.delegationId, "thread-old", "replaced", at(2));
      yield* linkThread(h, "c", "m1", "thread-new", 2);
      const query = delegationQuery(h, old.delegationId);
      const fresh = yield* Inbox.readDelegation(query).pipe(Effect.provide(h.layer));
      expect(fresh.draft).toBeNull();
      expect(fresh.delegation.hasDraft).toBe(false);
      expect(fresh.previousThreads.map((thread) => thread.threadId)).toEqual(["thread-old"]);
      // The old thread finishes later and writes again.
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(old.dir, "draft.md"), "late\n"));
      expect((yield* Inbox.readDelegation(query).pipe(Effect.provide(h.layer))).draft).toBeNull();
    }),
  );

  it.effect("drops a deleted thread's draft from the delegation's state", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneConversation));
      const { dir, delegationId } = yield* linkThread(h, "c", "m1", "thread-1", 1);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "reply\n"));
      const query = delegationQuery(h, delegationId);
      expect(
        (yield* Inbox.readDelegation(query).pipe(Effect.provide(h.layer))).delegation.hasDraft,
      ).toBe(true);
      h.shells.set("thread-1", null);
      // What followLinkedThreads publishes on thread.deleted.
      h.runtime.hub.publish({ type: "inbox", channelId: h.channelId });
      const after = yield* Inbox.readDelegation(query).pipe(Effect.provide(h.layer));
      expect(after.delegation).toMatchObject({ hasDraft: false });
      expect(after.draft).toBeNull();
    }),
  );

  it.effect("does not count a blank draft", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneConversation));
      const { dir } = yield* linkThread(h, "c", "m1", "thread-1", 1);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, "draft.md"), " \n\n"));
      const result = yield* listOf(h);
      expect(result.delegations[0]).toMatchObject({ hasDraft: false });
    }),
  );
});

describe("following linked threads", () => {
  it.effect("refreshes a channel when one of its linked threads changes, and only then", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(() => []));
      yield* linkThread(h, "c", "m1", "thread-linked", 1);
      const published: unknown[] = [];
      h.runtime.hub.subscribe((event) => published.push(event));
      const event = (type: string, threadId: string, status = "running", runId = "run-1") =>
        ({ type, threadId, payload: { id: runId, status } }) as never;
      yield* followLinkedThreads(
        Stream.fromIterable([
          event("run.updated", "thread-linked"),
          // Usage and checkpoint updates leave the run's status as it was.
          event("run.updated", "thread-linked"),
          event("run.updated", "thread-elsewhere"),
          // Streaming text does not change what the inbox shows.
          event("message.updated", "thread-linked"),
          event("run.updated", "thread-linked", "completed"),
          event("run.updated", "thread-linked", "running", "run-2"),
        ]),
      ).pipe(Effect.provide(h.layer));
      expect(published).toEqual(
        Array.from({ length: 3 }, () => ({ type: "inbox", channelId: h.channelId })),
      );
    }),
  );
});

describe("sending", () => {
  const oneConversation = (): ReadonlyArray<FakeConversation> => [
    { id: "c", messages: [{ id: "m1", minute: 1, author: THEM }] },
  ];

  it.effect("keeps the draft when the adapter does not confirm a message id", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(oneConversation, () => json(200, { ok: true })),
      );
      const { dir, delegationId } = yield* linkThread(h, "c", "m1", "thread-1", 1);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "reply\n"));
      const error = yield* Inbox.send({ ...h.keyOf("c"), delegationId, text: "reply" }).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error.code).toBe("delivery_unknown");
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(dir, "draft.md"), "utf8")),
      ).toBe("reply\n");
    }),
  );

  it.effect("records what was actually sent from a delegation, edited draft or typed reply", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneConversation));
      const { dir, delegationId } = yield* linkThread(h, "c", "m1", "thread-1", 1);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "draft text\n"),
      );
      const sent = yield* Inbox.send({
        ...h.keyOf("c"),
        delegationId,
        replyToId: "m1",
        text: "edited text",
      }).pipe(Effect.provide(h.layer));
      expect(sent.messageId).toBe("sent-1");
      expect(h.posted).toEqual([{ conversationId: "c", replyToId: "m1", text: "edited text" }]);
      const delegationDir = NodePath.join(h.runtime.itemsDir, delegationId);
      const files = yield* Effect.promise(() => NodeFSP.readdir(delegationDir));
      const record = files.find((file) => file.startsWith("sent."));
      expect(record).toBeDefined();
      const text = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(delegationDir, record!), "utf8"),
      );
      expect(text).toContain("edited text");
      expect(text).toContain('messageId: "sent-1"');
      expect(text).toContain("source: edited draft");
      const threadFiles = yield* Effect.promise(() => NodeFSP.readdir(dir));
      expect(threadFiles).not.toContain("draft.md");
      expect(threadFiles.some((file) => /^draft\..+\.md$/.test(file))).toBe(true);
      const listed = yield* Inbox.listInbox(h.channelId).pipe(Effect.provide(h.layer));
      expect(listed.delegations[0]!.lastSentAt).not.toBeNull();

      const typed = yield* Effect.promise(() => harness(oneConversation));
      const typedId = saveDelegation(typed, "c", "m1");
      yield* Inbox.send({ ...typed.keyOf("c"), delegationId: typedId, text: "by hand" }).pipe(
        Effect.provide(typed.layer),
      );
      const typedDir = NodePath.join(typed.runtime.itemsDir, typedId);
      const [typedRecord] = yield* Effect.promise(() => NodeFSP.readdir(typedDir));
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(typedDir, typedRecord!), "utf8"),
        ),
      ).toContain("source: typed");

      // A reply outside any delegation keeps no copy.
      const plain = yield* Inbox.send({ ...typed.keyOf("c"), text: "hi" }).pipe(
        Effect.provide(typed.layer),
      );
      expect(plain).toEqual({
        messageId: "sent-1",
        archived: null,
        unresolvedMentions: [],
        failedAttachments: [],
      });
    }),
  );

  it.effect("reports a sent message whose copy could not be saved, without failing the send", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneConversation));
      const delegationId = saveDelegation(h, "c", "m1");
      // A file where the delegation's folder should be: the copy cannot be written.
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(h.runtime.itemsDir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(h.runtime.itemsDir, delegationId), "");
      });
      const sent = yield* Inbox.send({ ...h.keyOf("c"), delegationId, text: "reply" }).pipe(
        Effect.provide(h.layer),
      );
      expect(sent.archived).toBe(false);
    }),
  );

  it.effect("sends the mentions the text holds, and only to an adapter that takes them", () =>
    Effect.gen(function* () {
      const text = "@Jordan and @Sam: fixed";
      const mentions = [
        { userId: "u2", name: "Jordan" },
        { userId: "u3", name: "Sam" },
        // A second Jordan cannot be told apart in the text, and Robin is not in it.
        { userId: "u4", name: "Jordan" },
        { userId: "u5", name: "Robin" },
      ];
      const h = yield* Effect.promise(() =>
        harness(
          oneConversation,
          () => json(200, { messageId: "sent-1", unresolvedMentions: ["u3"] }),
          { capabilities: ["mentions"] },
        ),
      );
      const sent = yield* Inbox.send({ ...h.keyOf("c"), text, mentions }).pipe(
        Effect.provide(h.layer),
      );
      expect(h.posted).toEqual([{ conversationId: "c", text, mentions: mentions.slice(0, 2) }]);
      expect(sent.unresolvedMentions).toEqual(["Sam"]);

      const plain = yield* Effect.promise(() => harness(oneConversation));
      yield* Inbox.send({ ...plain.keyOf("c"), text, mentions }).pipe(Effect.provide(plain.layer));
      expect(plain.posted).toEqual([{ conversationId: "c", text }]);
    }),
  );

  it.effect("says whether a reply goes into the thread, only to an adapter that takes quotes", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(oneConversation, undefined, { capabilities: ["quotes"] }),
      );
      for (const inThread of [false, true]) {
        yield* Inbox.send({ ...h.keyOf("c"), replyToId: "m1", inThread, text: "hi" }).pipe(
          Effect.provide(h.layer),
        );
      }
      // Without a message to answer there is no thread to choose.
      yield* Inbox.send({ ...h.keyOf("c"), inThread: false, text: "hi" }).pipe(
        Effect.provide(h.layer),
      );
      expect(h.posted).toEqual([
        { conversationId: "c", replyToId: "m1", inThread: false, text: "hi" },
        { conversationId: "c", replyToId: "m1", inThread: true, text: "hi" },
        { conversationId: "c", text: "hi" },
      ]);

      const plain = yield* Effect.promise(() => harness(oneConversation));
      yield* Inbox.send({ ...plain.keyOf("c"), replyToId: "m1", inThread: false, text: "hi" }).pipe(
        Effect.provide(plain.layer),
      );
      expect(plain.posted).toEqual([{ conversationId: "c", replyToId: "m1", text: "hi" }]);
    }),
  );

  it.effect("sends Markdown and uploaded files, and only to an adapter that takes them", () =>
    Effect.gen(function* () {
      const attachments = [
        { uploadId: "up-1", name: "chart.png" },
        { uploadId: "up-2", name: "log.txt" },
      ];
      const upload = { uploadId: "up-1", kind: "image", name: "chart.png", size: 3 };
      const h = yield* Effect.promise(() =>
        harness(
          oneConversation,
          () => json(200, { ...upload, messageId: "sent-1", failedAttachments: ["up-2"] }),
          { capabilities: ["markdown", "attachments"] },
        ),
      );
      const file = new URLSearchParams({ channelId: h.channelId, name: "my chart.png" });
      expect(
        yield* Inbox.upload(file, new Uint8Array([1, 2, 3])).pipe(Effect.provide(h.layer)),
      ).toEqual(upload);
      expect(h.requests).toContain("/uploads?name=my%20chart.png");
      expect(h.uploaded).toEqual([3]);

      // Files alone are a message; the adapter gets ids, the user gets the failed names.
      const sent = yield* Inbox.send({
        ...h.keyOf("c"),
        text: "",
        format: "markdown",
        attachments,
      }).pipe(Effect.provide(h.layer));
      expect(h.posted).toEqual([
        {
          conversationId: "c",
          text: "",
          format: "markdown",
          attachments: [{ uploadId: "up-1" }, { uploadId: "up-2" }],
        },
      ]);
      expect(sent.failedAttachments).toEqual(["log.txt"]);

      const plain = yield* Effect.promise(() => harness(oneConversation));
      yield* Inbox.send({ ...plain.keyOf("c"), text: "**hi**", format: "markdown" }).pipe(
        Effect.provide(plain.layer),
      );
      expect(plain.posted).toEqual([{ conversationId: "c", text: "**hi**" }]);
      const noFiles = yield* Inbox.send({
        ...plain.keyOf("c"),
        text: "see file",
        attachments,
      }).pipe(Effect.provide(plain.layer), Effect.flip);
      const noUpload = yield* Inbox.upload(
        new URLSearchParams({ channelId: plain.channelId, name: "a.png" }),
        new Uint8Array([1]),
      ).pipe(Effect.provide(plain.layer), Effect.flip);
      expect([noFiles.status, noUpload.status]).toEqual([400, 400]);
      expect(plain.posted).toHaveLength(1);
    }),
  );
});

describe("channel settings", () => {
  it.effect("returns a tested channel in the same shape as the list", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(() => []));
      const tested = yield* Inbox.testChannel(h.channelId).pipe(Effect.provide(h.layer));
      expect(tested.projectMatches).toEqual([
        { path: "~/code/somewhere", projectId: null, projectTitle: null },
      ]);
      const listed = yield* Inbox.listChannels().pipe(Effect.provide(h.layer));
      expect(Object.keys(tested).toSorted()).toEqual(
        Object.keys(listed.channels.find((channel) => channel.id === h.channelId)!).toSorted(),
      );
    }),
  );
});

describe("delegateExclusively", () => {
  it.effect("launches once when the same message is delegated twice at once", () =>
    Effect.gen(function* () {
      const links: Array<{ threadId: string; projectId: string }> = [];
      const gate = yield* Deferred.make<void>();
      let launches = 0;
      const run = Inbox.delegateExclusively({
        key: "delegation-concurrent",
        replaceThreadId: null,
        current: Effect.sync(() => links.at(-1) ?? null),
        start: () =>
          Effect.gen(function* () {
            launches += 1;
            yield* Deferred.await(gate);
            const thread = { threadId: `thread-${launches}`, projectId: "p" };
            links.push(thread);
            return thread;
          }),
      });
      const first = yield* Effect.forkChild(run);
      const second = yield* Effect.forkChild(run);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      const results = [yield* Fiber.join(first), yield* Fiber.join(second)];
      expect(launches).toBe(1);
      expect(results.map((result) => result.threadId)).toEqual(["thread-1", "thread-1"]);
      expect(results.map((result) => result.existing).toSorted()).toEqual([false, true]);
    }),
  );

  it.effect("replaces a thread once, not once per concurrent request", () =>
    Effect.gen(function* () {
      const links = [{ threadId: "thread-0", projectId: "p" }];
      let launches = 0;
      const run = Inbox.delegateExclusively({
        key: "delegation-replace",
        replaceThreadId: "thread-0",
        current: Effect.sync(() => links.at(-1) ?? null),
        start: (replacing) =>
          Effect.sync(() => {
            launches += 1;
            expect(replacing?.threadId).toBe("thread-0");
            const thread = { threadId: `thread-${launches}`, projectId: "p" };
            links.push(thread);
            return thread;
          }),
      });
      const results = yield* Effect.all([run, run], { concurrency: "unbounded" });
      expect(launches).toBe(1);
      expect(results.map((result) => result.threadId)).toEqual(["thread-1", "thread-1"]);
    }),
  );
});

// The run's records come from a thread; kept here so the fallback has one end-to-end case.
describe("tagged replies", () => {
  it.effect("fills only the current thread's folder from its finished run", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [{ id: "c", messages: [{ id: "m1", minute: 1, author: THEM }] }]),
      );
      const { dir, delegationId } = yield* linkThread(h, "c", "m1", "thread-1", 1);
      h.shells.set("thread-1", {
        ...idleShell("thread-1"),
        latestRunId: "run-1",
        latestRunCompletedAt: DateTime.makeUnsafe(at(2)),
      } as unknown as OrchestrationV2ThreadShell);
      const layer = Layer.merge(
        h.layer,
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(h.shells.get(threadId) ?? null),
          getThreadRecords: () =>
            Effect.succeed({
              messages: [
                {
                  text: "Done. <draft>fixed it</draft>",
                  streaming: false,
                  createdAt: DateTime.makeUnsafe(at(2)),
                },
              ],
            } as never),
        }),
      );
      const detail = yield* Inbox.readDelegation(delegationQuery(h, delegationId)).pipe(
        Effect.provide(layer),
      );
      expect(detail.draft).toBe("fixed it");
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(dir, "draft.md"), "utf8")),
      ).toBe("fixed it\n");
    }),
  );
});
