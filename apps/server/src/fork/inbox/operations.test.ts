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
import { itemIdFor } from "./derive.ts";
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
}

interface FakeTopic {
  readonly conversationId: string;
  readonly kind?: "dm" | "group" | "topic_group";
  readonly topicId: string;
  readonly messages: ReadonlyArray<FakeMessage>;
}

/** An adapter that serves one item per page, so every list takes several requests. */
function fakeAdapter(topics: () => ReadonlyArray<FakeTopic>, sendAnswer: () => AdapterResponse) {
  const paged = (items: ReadonlyArray<unknown>, url: URL) => {
    const index = Number(url.searchParams.get("cursor") ?? "0");
    return json(200, {
      items: items.slice(index, index + 1),
      nextCursor: index + 1 < items.length ? String(index + 1) : null,
    });
  };
  const messageJson = (message: FakeMessage, topicId: string) => ({
    id: message.id,
    topicId,
    createdAt: at(message.minute),
    author: message.author,
    mentionsSelf: message.mentionsSelf ?? false,
    text: `text of ${message.id}`,
    attachments: message.image ? [{ ...message.image, kind: "image" }] : [],
    links: [],
  });
  return (request: AdapterRequest): AdapterResponse => {
    const url = new URL(request.path, "http://adapter.invalid");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (request.method === "POST") return sendAnswer();
    if (url.pathname === "/health") {
      return json(200, {
        protocol: 1,
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
        delegateTemplates: [{ id: "t", name: "T", prompt: "{contextDir}" }],
        relevanceSummary: "All",
      });
    }
    const all = topics();
    if (parts.length === 1 && parts[0] === "conversations") {
      const ids = [...new Set(all.map((topic) => topic.conversationId))];
      return paged(
        ids.map((id) => ({
          id,
          kind: all.find((topic) => topic.conversationId === id)?.kind ?? "group",
          name: id,
          lastActivityAt: at(0),
          relevant: true,
          muted: false,
        })),
        url,
      );
    }
    if (parts[2] === "topics") {
      return paged(
        all
          .filter((topic) => topic.conversationId === parts[1])
          .map((topic) => {
            const sorted = topic.messages.toSorted((a, b) => a.minute - b.minute);
            const last = sorted[sorted.length - 1]!;
            const lastOwn = sorted.findLastIndex((message) => message.author.isSelf);
            const lastOther = sorted.findLast((message) => !message.author.isSelf);
            return {
              id: topic.topicId,
              rootMessageId: sorted[0]!.id,
              rootPreview: topic.topicId,
              replyCount: sorted.length - 1,
              lastMessageAt: at(last.minute),
              lastAuthor: last.author,
              participatedBySelf: lastOwn !== -1,
              lastOtherMessageAt: lastOther ? at(lastOther.minute) : null,
              mentionsSelfSinceOwn: sorted
                .slice(lastOwn + 1)
                .some((message) => message.mentionsSelf === true),
            };
          }),
        url,
      );
    }
    if (parts[2] === "messages") {
      const wanted = url.searchParams.get("topic");
      // Newest first, as some adapters page: the inbox must sort before reading.
      const messages = all
        .filter(
          (candidate) =>
            candidate.conversationId === parts[1] &&
            (wanted === null || candidate.topicId === wanted),
        )
        .flatMap((topic) => topic.messages.map((message) => ({ message, topic })))
        .toSorted((a, b) => b.message.minute - a.message.minute)
        .map(({ message, topic }) => messageJson(message, topic.topicId));
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
  readonly runtime: InboxRuntime["Service"];
  readonly shells: Map<string, OrchestrationV2ThreadShell | null>;
  /** Each thread's messages, as `getThreadRecords` reads them. */
  readonly threadMessages: Map<string, ReadonlyArray<unknown>>;
  /** What was sent to threads. */
  readonly sent: Array<ThreadManagement.ThreadManagementSendInput>;
  readonly layer: Layer.Layer<
    InboxRuntime | ThreadManagement.ThreadManagementService | Project.ProjectService
  >;
  readonly keyOf: (
    conversationId: string,
    topicId: string,
  ) => {
    readonly channelId: string;
    readonly conversationId: string;
    readonly topicId: string;
  };
}

async function harness(
  topics: () => ReadonlyArray<FakeTopic>,
  sendAnswer: () => AdapterResponse = () => json(200, { messageId: "sent-1" }),
): Promise<Harness> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-inbox-"));
  const tokenFile = NodePath.join(dir, "token");
  await NodeFSP.writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const handle = fakeAdapter(topics, sendAnswer);
  const requests: string[] = [];
  const hub = new ChannelHub({
    configPath: NodePath.join(dir, "channels.json"),
    transportFor: () => ({
      request: async (request) => {
        requests.push(request.path);
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
  store.readAllBefore(channelId, "2026-01-01T00:00:00.000Z");
  const runtime = {
    hub,
    store,
    channelsDir: dir,
    itemsDir: NodePath.join(dir, "items"),
    subscribe: (listener: Parameters<ChannelHub["subscribe"]>[0]) => hub.subscribe(listener),
  };
  const shells = new Map<string, OrchestrationV2ThreadShell | null>();
  const threadMessages = new Map<string, ReadonlyArray<unknown>>();
  const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const layer = Layer.mergeAll(
    Layer.succeed(InboxRuntime, runtime),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      getThreadRecords: (threadId) =>
        Effect.succeed({ messages: threadMessages.get(threadId) ?? [] } as never),
      sendToThread: (input) => {
        sent.push(input);
        return Effect.succeed({ message: { attachments: [] } } as never);
      },
    }),
    Layer.mock(Project.ProjectService)({ listShells: () => Effect.succeed([]) }),
  );
  return {
    channelId,
    requests,
    runtime,
    shells,
    threadMessages,
    sent,
    layer,
    keyOf: (conversationId, topicId) => ({ channelId, conversationId, topicId }),
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

const linkThread = (
  h: Harness,
  key: ReturnType<Harness["keyOf"]>,
  threadId: string,
  minute: number,
) =>
  Effect.promise(async () => {
    const itemId = itemIdFor(key);
    h.runtime.store.addLink({ ...key, itemId, threadId, projectId: "p", createdAt: at(minute) });
    h.shells.set(threadId, idleShell(threadId));
    const dir = threadContextDir(h.runtime.itemsDir, itemId, threadId);
    await NodeFSP.mkdir(dir, { recursive: true });
    return dir;
  });

describe("inbox listing", () => {
  it.effect("reads every page of conversations, topics, and messages", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [
          {
            conversationId: "c-first",
            topicId: "t-a",
            messages: [{ id: "a1", minute: 1, author: THEM }],
          },
          {
            conversationId: "c-second",
            topicId: "t-joined",
            messages: [
              // Oldest first: the adapter pages newest first, so these come last.
              { id: "j1", minute: 1, author: ME },
              { id: "j2", minute: 2, author: THEM },
              { id: "j3", minute: 3, author: THEM },
              { id: "j4", minute: 4, author: THEM, mentionsSelf: true },
            ],
          },
          {
            conversationId: "c-second",
            topicId: "t-second-page",
            messages: [
              { id: "s1", minute: 5, author: THEM, image: { key: "k", name: "same.png" } },
              { id: "s2", minute: 6, author: ME },
            ],
          },
        ]),
      );
      const result = yield* Inbox.listItems(h.channelId).pipe(Effect.provide(h.layer));
      const byTopic = new Map(result.items.map((item) => [item.topicId, item] as const));
      expect([...byTopic.keys()].toSorted()).toEqual(["t-a", "t-joined", "t-second-page"]);
      // A topic I joined that mentions me after my last message is direct, not participated.
      expect(byTopic.get("t-joined")).toMatchObject({ category: "direct", unread: true });
      expect(byTopic.get("t-second-page")).toMatchObject({ unread: false, awaitingReply: true });

      const topic = yield* Inbox.readTopic(
        new URLSearchParams(h.keyOf("c-second", "t-joined")),
      ).pipe(Effect.provide(h.layer));
      expect(topic.messages.map((message) => message.id)).toEqual(["j1", "j2", "j3", "j4"]);

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
    }),
  );

  it.effect("reads a topic up to what the client saw, and unreads it on a newer message", () =>
    Effect.gen(function* () {
      const messages: FakeMessage[] = [{ id: "m1", minute: 1, author: THEM }];
      const h = yield* Effect.promise(() =>
        harness(() => [{ conversationId: "c", topicId: "t", messages }]),
      );
      const key = h.keyOf("c", "t");
      const list = () =>
        Inbox.listItems(h.channelId).pipe(
          Effect.map((result) => result.items[0]),
          Effect.provide(h.layer),
        );
      h.requests.length = 0;
      yield* Inbox.setRead({ ...key, read: true, lastMessageAt: at(1) }).pipe(
        Effect.provide(h.layer),
      );
      expect(h.requests).toEqual([]);
      expect(yield* list()).toMatchObject({ unread: false });
      messages.push({ id: "m2", minute: 2, author: THEM });
      h.runtime.hub.invalidate(h.channelId);
      expect(yield* list()).toMatchObject({ unread: true });
      yield* Inbox.setRead({ ...key, read: true, lastMessageAt: at(2) }).pipe(
        Effect.provide(h.layer),
      );
      yield* Inbox.setRead({ ...key, read: false }).pipe(Effect.provide(h.layer));
      expect(yield* list()).toMatchObject({ unread: true });
      yield* Inbox.markAllRead({ channelId: h.channelId, before: at(2) }).pipe(
        Effect.provide(h.layer),
      );
      expect(yield* list()).toMatchObject({ unread: false });
      // Overview counts only what is still unread.
      const overview = yield* Inbox.overview().pipe(Effect.provide(h.layer));
      expect(overview.channels.find((channel) => channel.id === h.channelId)?.unreadCount).toBe(0);
    }),
  );

  it.effect("shows a finished run until the client reports seeing it", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [
          { conversationId: "c", topicId: "t", messages: [{ id: "m1", minute: 1, author: ME }] },
        ]),
      );
      const key = h.keyOf("c", "t");
      yield* linkThread(h, key, "thread-1", 1);
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
      const item = () =>
        Inbox.listItems(h.channelId).pipe(
          Effect.map((result) => result.items[0]),
          Effect.provide(h.layer),
        );
      finished("completed");
      expect(yield* item()).toMatchObject({
        unread: true,
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
      yield* Inbox.setRead({ ...key, read: true, runCompletedAt: at(5) }).pipe(
        Effect.provide(h.layer),
      );
      expect(yield* item()).toMatchObject({ unread: false, agentUnseen: false });
    }),
  );

  it.effect("shares one read of the channel until something in it changes", () =>
    Effect.gen(function* () {
      const messages: FakeMessage[] = [{ id: "m1", minute: 1, author: THEM }];
      const h = yield* Effect.promise(() =>
        harness(() => [{ conversationId: "c", topicId: "t", messages }]),
      );
      const key = h.keyOf("c", "t");
      const reads = vi.spyOn(h.runtime.store, "listReads");
      yield* Effect.all(
        [Inbox.overview(), Inbox.listItems(h.channelId), Inbox.readTopic(new URLSearchParams(key))],
        { concurrency: "unbounded" },
      ).pipe(Effect.provide(h.layer));
      expect(reads).toHaveBeenCalledTimes(1);
      yield* Inbox.setRead({ ...key, read: true, lastMessageAt: at(1) }).pipe(
        Effect.provide(h.layer),
      );
      const result = yield* Inbox.listItems(h.channelId).pipe(Effect.provide(h.layer));
      expect(reads).toHaveBeenCalledTimes(2);
      expect(result.items[0]).toMatchObject({ unread: false });
      expect(result.items[0]).not.toHaveProperty("waitMs");
    }),
  );

  it.effect("says when the channel lists more conversations than it reads", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() =>
          Array.from({ length: 21 }, (_, index) => ({
            conversationId: `c${index}`,
            topicId: "t",
            messages: [{ id: `m${index}`, minute: 1, author: THEM }],
          })),
        ),
      );
      const result = yield* Inbox.listItems(h.channelId).pipe(Effect.provide(h.layer));
      expect(result.items).toHaveLength(20);
      expect(result.truncatedAtPages).toBe(20);
    }),
  );
});

describe("delegating", () => {
  it.effect("offers the project the topic's last thread used", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [
          { conversationId: "c", topicId: "t", messages: [{ id: "m1", minute: 1, author: THEM }] },
        ]),
      );
      const key = h.keyOf("c", "t");
      h.runtime.store.addLink({
        ...key,
        itemId: itemIdFor(key),
        threadId: "thread-1",
        projectId: "p-second",
        createdAt: at(1),
      });
      h.shells.set("thread-1", {
        ...idleShell("thread-1"),
        worktreePath: "/code/p-second-worktree",
      } as OrchestrationV2ThreadShell);
      const project = (id: string) => ({
        id,
        title: id,
        workspaceRoot: `/code/${id}`,
        archivedAt: null,
      });
      const options = yield* Inbox.delegateOptions(new URLSearchParams(key)).pipe(
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
      expect(options.defaultProjectId).toBe("p-second");
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
        harness(() =>
          ["t-root", "t-worktree", "t-bad"].map((topicId) => ({
            conversationId: "c",
            topicId,
            messages: [{ id: `m-${topicId}`, minute: 1, author: THEM }],
          })),
        ),
      );
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const layer = Layer.mergeAll(
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
      const delegate = (topicId: string, workspaceStrategy?: unknown) =>
        Inbox.delegate({
          ...h.keyOf("c", topicId),
          projectId: "p",
          templateId: "t",
          modelSelection: { instanceId: "codex", model: "gpt" },
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
        }).pipe(Effect.provide(layer));

      yield* delegate("t-root");
      const worktree = { type: "worktree", baseRef: "main", startFromOrigin: true };
      yield* delegate("t-worktree", worktree);
      expect(launched.map((input) => input.workspaceStrategy)).toEqual([
        { type: "root" },
        worktree,
      ]);
      const request = yield* Effect.promise(() =>
        NodeFSP.readFile(
          NodePath.join(
            threadContextDir(
              h.runtime.itemsDir,
              itemIdFor(h.keyOf("c", "t-worktree")),
              launched[1]!.threadId!,
            ),
            "request.json",
          ),
          "utf8",
        ),
      );
      expect(JSON.parse(request).workspaceStrategy).toEqual(worktree);

      const error = yield* delegate("t-bad", { type: "worktree" }).pipe(Effect.flip);
      expect(error).toMatchObject({ status: 400, field: "workspaceStrategy" });
      expect(launched).toHaveLength(2);
    }),
  );

  it.effect("refuses a topic longer than the pages it reads, before starting anything", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() =>
        harness(() => [
          {
            conversationId: "c",
            kind: "dm",
            topicId: "t",
            messages: Array.from({ length: 51 }, (_, index) => ({
              id: `m${index}`,
              minute: index,
              author: THEM,
            })),
          },
        ]),
      );
      const error = yield* Inbox.delegate({
        ...h.keyOf("c", "t"),
        projectId: "p",
        templateId: "t",
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
      expect(error.code).toBe("topic_too_long");
      expect(h.runtime.store.listLinks(h.channelId)).toEqual([]);
    }),
  );
});

describe("linked threads and their files", () => {
  const oneTopic = (): ReadonlyArray<FakeTopic> => [
    {
      conversationId: "c",
      kind: "dm",
      topicId: "t",
      messages: [{ id: "m1", minute: 1, author: THEM }],
    },
  ];

  it.effect("shows only the current thread's draft, whatever an older thread writes", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneTopic));
      const key = h.keyOf("c", "t");
      const oldDir = yield* linkThread(h, key, "thread-old", 1);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(oldDir, "draft.md"), "old\n"));
      // A second delegation replaced the first.
      h.runtime.store.detachLink(itemIdFor(key), "thread-old", "replaced", at(2));
      yield* linkThread(h, key, "thread-new", 2);
      const query = new URLSearchParams(key);
      const fresh = yield* Inbox.readTopic(query).pipe(Effect.provide(h.layer));
      expect(fresh.draft).toBeNull();
      expect(fresh.item.hasDraft).toBe(false);
      expect(fresh.previousThreads.map((thread) => thread.threadId)).toEqual(["thread-old"]);
      // The old thread finishes later and writes again.
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(oldDir, "draft.md"), "late\n"));
      expect((yield* Inbox.readTopic(query).pipe(Effect.provide(h.layer))).draft).toBeNull();
    }),
  );

  it.effect("treats a deleted thread's files as history, not as the item's state", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneTopic));
      const key = h.keyOf("c", "t");
      const dir = yield* linkThread(h, key, "thread-1", 1);
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "reply\n"),
          NodeFSP.writeFile(NodePath.join(dir, "conclusion.md"), "cause\n"),
        ]),
      );
      const query = new URLSearchParams(key);
      expect((yield* Inbox.readTopic(query).pipe(Effect.provide(h.layer))).item.hasDraft).toBe(
        true,
      );
      h.shells.set("thread-1", null);
      // What followLinkedThreads publishes on thread.deleted.
      h.runtime.hub.publish({ type: "inbox", channelId: h.channelId });
      const after = yield* Inbox.readTopic(query).pipe(Effect.provide(h.layer));
      expect(after.item).toMatchObject({ hasDraft: false });
      expect(after).toMatchObject({
        draft: null,
        conclusion: "cause",
        conclusionIsHistorical: true,
      });
    }),
  );

  it.effect("does not count a blank draft", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneTopic));
      const dir = yield* linkThread(h, h.keyOf("c", "t"), "thread-1", 1);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, "draft.md"), " \n\n"));
      const result = yield* Inbox.listItems(h.channelId).pipe(Effect.provide(h.layer));
      expect(result.items[0]).toMatchObject({ hasDraft: false });
    }),
  );
});

describe("following linked threads", () => {
  it.effect("refreshes a channel when one of its linked threads changes, and only then", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(() => []));
      yield* linkThread(h, h.keyOf("c", "t"), "thread-linked", 1);
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
  const oneTopic = () => [
    { conversationId: "c", topicId: "t", messages: [{ id: "m1", minute: 1, author: THEM }] },
  ];

  it.effect("keeps the draft when the adapter does not confirm a message id", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneTopic, () => json(200, { ok: true })));
      const key = h.keyOf("c", "t");
      const dir = yield* linkThread(h, key, "thread-1", 1);
      yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "reply\n"));
      const error = yield* Inbox.send({ ...key, text: "reply" }).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error.code).toBe("delivery_unknown");
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(dir, "draft.md"), "utf8")),
      ).toBe("reply\n");
    }),
  );

  it.effect("records what was actually sent, edited draft or typed reply", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneTopic));
      const key = h.keyOf("c", "t");
      const dir = yield* linkThread(h, key, "thread-1", 1);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(dir, "draft.md"), "draft text\n"),
      );
      const sent = yield* Inbox.send({ ...key, text: "edited text" }).pipe(Effect.provide(h.layer));
      expect(sent.messageId).toBe("sent-1");
      const itemDir = NodePath.join(h.runtime.itemsDir, itemIdFor(key));
      const files = yield* Effect.promise(() => NodeFSP.readdir(itemDir));
      const record = files.find((file) => file.startsWith("sent."));
      expect(record).toBeDefined();
      const text = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(itemDir, record!), "utf8"),
      );
      expect(text).toContain("edited text");
      expect(text).toContain('messageId: "sent-1"');
      expect(text).toContain("source: edited draft");
      const threadFiles = yield* Effect.promise(() => NodeFSP.readdir(dir));
      expect(threadFiles).not.toContain("draft.md");
      expect(threadFiles.some((file) => /^draft\..+\.md$/.test(file))).toBe(true);

      const typed = yield* Effect.promise(() => harness(oneTopic));
      const typedKey = typed.keyOf("c", "t");
      yield* Inbox.send({ ...typedKey, text: "by hand" }).pipe(Effect.provide(typed.layer));
      const typedDir = NodePath.join(typed.runtime.itemsDir, itemIdFor(typedKey));
      const [typedRecord] = yield* Effect.promise(() => NodeFSP.readdir(typedDir));
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(typedDir, typedRecord!), "utf8"),
        ),
      ).toContain("source: typed");
    }),
  );

  it.effect("reports a sent message whose copy could not be saved, without failing the send", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneTopic));
      const key = h.keyOf("c", "t");
      // A file where the item folder should be: the copy cannot be written.
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(h.runtime.itemsDir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(h.runtime.itemsDir, itemIdFor(key)), "");
      });
      const sent = yield* Inbox.send({ ...key, text: "reply" }).pipe(Effect.provide(h.layer));
      expect(sent).toEqual({ messageId: "sent-1", archived: false });
    }),
  );
});

describe("asking a topic's thread", () => {
  const oneTopic = (): ReadonlyArray<FakeTopic> => [
    { conversationId: "c", topicId: "t", messages: [{ id: "m1", minute: 1, author: THEM }] },
  ];
  const askLayer = (h: Harness) =>
    Layer.mergeAll(
      h.layer,
      Layer.succeed(ServerConfig.ServerConfig, {} as never),
      Layer.mock(DocumentText.DocumentText)({}),
      FileSystem.layerNoop({}),
    );

  it.effect("asks only a topic that has a thread, and queues behind a running one", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneTopic));
      const key = h.keyOf("c", "t");
      const ask = Inbox.ask({ ...key, text: " Why? " }).pipe(Effect.provide(askLayer(h)));
      expect(yield* Effect.flip(ask)).toMatchObject({ status: 400 });
      expect(h.sent).toEqual([]);

      const dir = yield* linkThread(h, key, "thread-1", 1);
      yield* ask;
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({ threadId: "thread-1", projectId: "p", mode: "queue" });
      expect(h.sent[0]!.text).toMatch(/^Why\?\n\n\(If the reply/);
      expect(h.sent[0]!.text).toContain(`${dir}/draft.md`);
    }),
  );

  it.effect("shows the questions asked after the delegation without the note sent with them", () =>
    Effect.gen(function* () {
      const h = yield* Effect.promise(() => harness(oneTopic));
      const key = h.keyOf("c", "t");
      yield* linkThread(h, key, "thread-1", 1);
      yield* Inbox.ask({ ...key, text: "Why?" }).pipe(Effect.provide(askLayer(h)));
      const message = (role: string, text: string, runId: string | null, minute: number) => ({
        role,
        text,
        runId,
        streaming: false,
        createdAt: DateTime.makeUnsafe(at(minute)),
      });
      h.threadMessages.set("thread-1", [
        message("user", "Delegated", "run-1", 1),
        message("assistant", "Looked into it", "run-1", 2),
        message("user", h.sent[0]!.text, "run-2", 3),
        message("assistant", "Thinking", "run-2", 4),
        message("assistant", "Because of the cache", "run-2", 5),
        message("user", "And then?", null, 6),
      ]);
      const topic = yield* Inbox.readTopic(new URLSearchParams(key)).pipe(Effect.provide(h.layer));
      expect(topic.followUps.map(({ role, text }) => [role, text])).toEqual([
        ["user", "Why?"],
        ["assistant", "Because of the cache"],
        ["user", "And then?"],
      ]);
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
  it.effect("launches once when the same topic is delegated twice at once", () =>
    Effect.gen(function* () {
      const links: Array<{ threadId: string; projectId: string }> = [];
      const gate = yield* Deferred.make<void>();
      let launches = 0;
      const run = Inbox.delegateExclusively({
        itemId: "item-concurrent",
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
        itemId: "item-replace",
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
        harness(() => [
          { conversationId: "c", topicId: "t", messages: [{ id: "m1", minute: 1, author: THEM }] },
        ]),
      );
      const key = h.keyOf("c", "t");
      const dir = yield* linkThread(h, key, "thread-1", 1);
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
                  text: "Done. <conclusion>cause</conclusion> <draft>fixed it</draft>",
                  streaming: false,
                  createdAt: DateTime.makeUnsafe(at(2)),
                },
              ],
            } as never),
        }),
      );
      const topic = yield* Inbox.readTopic(new URLSearchParams(key)).pipe(Effect.provide(layer));
      expect(topic).toMatchObject({ conclusion: "cause", draft: "fixed it" });
      expect(
        yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(dir, "draft.md"), "utf8")),
      ).toBe("fixed it\n");
    }),
  );
});
