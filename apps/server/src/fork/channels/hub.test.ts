import {
  createTestHub,
  withTestClock,
  httpTransport,
  createTokenReader,
  readChannelsFile,
  type LegacyTransport as ChannelTransport,
} from "./channelTestkit.ts";
// @effect-diagnostics nodeBuiltinImport:off - Exercises the plain-TypeScript hub with temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { createSseParser } from "@t3tools/fork-client/sse";

import { ChannelConfigError, validateLoopbackBaseUrl, type ChannelConfigEntry } from "./config.ts";
import { channelAccess, nextCheckDelay, type ChannelStatus } from "./hub.ts";
import {
  AdapterConfig,
  AdapterError,
  CHANNEL_PROTOCOL_VERSION,
  ChannelHealth,
  Conversation,
  Message,
  RawPage,
  SendErrorCode,
  SendResult,
  Upload,
  parseChannelEvent,
  type ChannelEvent,
} from "./protocol.ts";
import { AdapterUnreachableError, type AdapterRequest, type AdapterResponse } from "./transport.ts";

const encoder = new TextEncoder();
const json = (status: number, value: unknown): AdapterResponse => ({
  status,
  contentType: "application/json",
  body: encoder.encode(JSON.stringify(value)),
});

const HEALTH = {
  protocol: CHANNEL_PROTOCOL_VERSION,
  adapterVersion: "1.2.3",
  online: true,
  loggedIn: true,
  lastSyncAt: "2026-11-14T08:00:00.000Z",
  self: { id: "u1", name: "Me" },
};
const CONFIG = {
  displayName: "Chat",
  defaultProjectPaths: [],
  relevanceSummary: "Everything",
};

function fakeTransport(handle: (request: AdapterRequest) => AdapterResponse): ChannelTransport {
  return {
    request: async (request) => handle(request),
    events: () => new Promise(() => undefined),
  };
}

async function tempDir() {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-channels-"));
}

async function hubWith(
  handle: (request: AdapterRequest) => AdapterResponse,
  entry: Partial<ChannelConfigEntry> = {},
  execute?: Parameters<typeof createTestHub>[1],
) {
  const dir = await tempDir();
  const tokenFile = NodePath.join(dir, "token");
  await NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 });
  const hub = await createTestHub(
    {
      configPath: NodePath.join(dir, "channels.json"),
      transportFor: () => fakeTransport(handle),
      background: false,
    },
    execute,
  );
  await hub.start();
  await hub.save(
    {
      id: "chat",
      kind: "http-adapter",
      name: "Chat",
      baseUrl: "http://127.0.0.1:7341",
      tokenFile,
      enabled: true,
      ...entry,
    },
    { create: true },
  );
  return { hub, dir };
}

describe("ChannelHub checks", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly handle: (request: AdapterRequest) => AdapterResponse;
    readonly entry?: Partial<ChannelConfigEntry>;
    readonly status: ChannelStatus;
    readonly failedStep: string | null;
  }> = [
    {
      name: "online",
      handle: (request) => json(200, request.path === "/health" ? HEALTH : CONFIG),
      status: "online",
      failedStep: null,
    },
    {
      name: "missing token file",
      handle: () => json(200, HEALTH),
      entry: { tokenFile: "/nonexistent/t3-token" },
      status: "token_missing",
      failedStep: "token",
    },
    {
      name: "unreachable",
      handle: () => {
        throw new AdapterUnreachableError({ message: "connect ECONNREFUSED" });
      },
      status: "unreachable",
      failedStep: "connect",
    },
    {
      name: "refused token",
      handle: () => json(401, { error: { code: "unauthorized", message: "no" } }),
      status: "unauthorized",
      failedStep: "auth",
    },
    {
      // Protocol v2 dropped topics; an adapter not yet upgraded is refused, not misread.
      name: "older protocol",
      handle: () => json(200, { ...HEALTH, protocol: CHANNEL_PROTOCOL_VERSION - 1 }),
      status: "incompatible",
      failedStep: "protocol",
    },
    {
      name: "newer protocol",
      handle: () => json(200, { ...HEALTH, protocol: CHANNEL_PROTOCOL_VERSION + 1 }),
      status: "incompatible",
      failedStep: "protocol",
    },
    {
      name: "signed out",
      handle: (request) =>
        json(200, request.path === "/health" ? { ...HEALTH, loggedIn: false } : CONFIG),
      status: "needs_login",
      failedStep: "login",
    },
    {
      name: "collector stopped",
      handle: (request) =>
        json(200, request.path === "/health" ? { ...HEALTH, online: false } : CONFIG),
      status: "collector_stopped",
      failedStep: "online",
    },
  ];

  it.each(cases)("reports $name", async (testCase) => {
    const { hub } = await hubWith(testCase.handle, testCase.entry);
    const view = await hub.test("chat");
    expect(view.status).toBe(testCase.status);
    expect(view.steps.find((step) => !step.ok)?.id ?? null).toBe(testCase.failedStep);
    await hub.stop();
  });

  it("serves the last answer while the adapter is unreachable", async () => {
    let up = true;
    const { hub } = await hubWith((request) => {
      if (!up) throw new AdapterUnreachableError({ message: "down" });
      if (request.path === "/health") return json(200, HEALTH);
      if (request.path === "/config") return json(200, CONFIG);
      return json(200, { items: [], nextCursor: null });
    });
    await hub.test("chat");
    const schema = RawPage;
    expect((await hub.getJson("chat", "/conversations", schema)).stale).toBe(false);
    up = false;
    hub.invalidate("chat");
    await hub.test("chat");
    expect(hub.get("chat")?.status).toBe("unreachable");
    expect(await hub.getJson("chat", "/conversations", schema)).toEqual({
      value: { items: [], nextCursor: null },
      stale: true,
    });
    await expect(hub.postJson("chat", "/messages", {})).rejects.toThrow();
    await hub.stop();
  });

  it("shares one adapter request among concurrent reads of a path, success or failure", async () => {
    let listed = 0;
    let failing = false;
    const { hub } = await hubWith((request) => {
      if (request.path === "/health") return json(200, HEALTH);
      if (request.path === "/config") return json(200, CONFIG);
      listed += 1;
      return failing
        ? json(500, { error: { code: "broken", message: "no" } })
        : json(200, { items: [], nextCursor: null });
    });
    await hub.test("chat");
    const readAll = () =>
      Promise.allSettled(
        Array.from({ length: 5 }, () => hub.getJson("chat", "/conversations", RawPage)),
      );
    expect((await readAll()).map((result) => result.status)).toEqual(Array(5).fill("fulfilled"));
    expect(listed).toBe(1);
    hub.invalidate("chat");
    failing = true;
    const failed = await readAll();
    expect(failed.map((result) => result.status)).toEqual(Array(5).fill("rejected"));
    expect(new Set(failed.map((result) => (result as PromiseRejectedResult).reason)).size).toBe(1);
    expect(listed).toBe(2);
    // A failure is not cached.
    await hub.getJson("chat", "/conversations", RawPage).catch(() => undefined);
    expect(listed).toBe(3);
    await hub.stop();
  });

  it.effect("announces a moved lastSyncAt as a sync, not as changed lists", () =>
    withTestClock(async (execute) => {
      let lastSyncAt = HEALTH.lastSyncAt;
      const { hub } = await hubWith(
        (request) => json(200, request.path === "/health" ? { ...HEALTH, lastSyncAt } : CONFIG),
        {},
        execute,
      );
      await hub.test("chat");
      const events: unknown[] = [];
      hub.subscribe((event) => events.push(event));
      await hub.test("chat");
      expect(events).toEqual([]);
      lastSyncAt = "2026-11-14T08:05:00.000Z";
      await hub.test("chat");
      expect(events).toEqual([{ type: "sync", channelId: "chat" }]);
      expect(hub.get("chat")?.health?.lastSyncAt).toBe(lastSyncAt);
      await hub.stop();
    }),
  );

  it("keeps ids stable and refuses duplicates", async () => {
    const { hub } = await hubWith((request) =>
      json(200, request.path === "/health" ? HEALTH : CONFIG),
    );
    await expect(
      hub.save(
        {
          id: "chat",
          kind: "http-adapter",
          name: "Again",
          baseUrl: "http://127.0.0.1:1",
          tokenFile: "",
          enabled: false,
        },
        { create: true },
      ),
    ).rejects.toBeInstanceOf(ChannelConfigError);
    const added = await hub.save(
      {
        id: "",
        kind: "http-adapter",
        name: "Chat",
        baseUrl: "http://127.0.0.1:1",
        tokenFile: "",
        enabled: false,
      },
      { create: true },
    );
    expect(added.id).toBe("chat-2");
    await hub.stop();
  });

  it("keeps the example channel: it cannot be removed or added again", async () => {
    const { hub } = await hubWith((request) =>
      json(200, request.path === "/health" ? HEALTH : CONFIG),
    );
    await expect(hub.remove("example")).rejects.toBeInstanceOf(ChannelConfigError);
    await expect(
      hub.save(
        { id: "", kind: "example", name: "Again", baseUrl: "", tokenFile: "", enabled: true },
        { create: true },
      ),
    ).rejects.toBeInstanceOf(ChannelConfigError);
    expect(hub.list().map((channel) => channel.id)).toEqual(["example", "chat"]);
    await hub.stop();
  });

  it("checks an adapter that is not saved yet, and keeps nothing of it", async () => {
    const { hub, dir } = await hubWith((request) =>
      json(200, request.path === "/health" ? HEALTH : CONFIG),
    );
    const probe = await hub.probe({
      baseUrl: "http://127.0.0.1:7342/",
      tokenFile: NodePath.join(dir, "token"),
    });
    expect(probe.status).toBe("online");
    expect(probe.config?.displayName).toBe("Chat");
    await expect(
      hub.probe({ baseUrl: "http://10.0.0.5:7341", tokenFile: "" }),
    ).rejects.toBeInstanceOf(ChannelConfigError);
    expect(hub.list().map((channel) => channel.id)).toEqual(["example", "chat"]);
    await hub.stop();
  });
});

describe("ChannelHub lists", () => {
  const conversation = (id: string) => ({
    id,
    kind: "group",
    name: id,
    lastActivityAt: "2026-11-14T08:00:00.000Z",
    relevant: true,
    muted: false,
    lastMessage: null,
    lastOtherMessageAt: null,
    lastSelfMessageAt: null,
    lastMentionAt: null,
  });
  const message = (id: string) => ({
    id,
    createdAt: "2026-11-14T08:00:00.000Z",
    author: { id: "u2", name: "Other", isSelf: false },
    mentionsSelf: false,
    text: id,
    attachments: [],
    links: [],
  });

  it.each([
    ["conversations", "/conversations?relevant=1", Conversation, conversation],
    ["messages", "/conversations/c/messages?root=t", Message, message],
  ] as const)("follows nextCursor through every page of %s", async (_name, path, schema, make) => {
    const asked: string[] = [];
    const { hub } = await hubWith((request) => {
      if (request.path === "/health") return json(200, HEALTH);
      if (request.path === "/config") return json(200, CONFIG);
      asked.push(request.path);
      return request.path.includes("cursor=p%202")
        ? json(200, { items: [make("b")], nextCursor: null })
        : json(200, { items: [make("a")], nextCursor: "p 2" });
    });
    await hub.test("chat");
    const result = await hub.getAllPages<{ readonly id: string }>("chat", path, schema, {
      maxPages: 10,
    });
    expect(result.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.complete).toBe(true);
    expect(asked).toEqual([path, `${path}${path.includes("?") ? "&" : "?"}cursor=p%202`]);
    await hub.stop();
  });

  it("stops after maxPages when the adapter never ends the list", async () => {
    let served = 0;
    const { hub } = await hubWith((request) => {
      if (request.path === "/health") return json(200, HEALTH);
      if (request.path === "/config") return json(200, CONFIG);
      served += 1;
      return json(200, { items: [], nextCursor: `n${served}` });
    });
    await hub.test("chat");
    const result = await hub.getAllPages("chat", "/conversations", Conversation, {
      maxPages: 3,
    });
    expect(result.complete).toBe(false);
    expect(served).toBe(3);
    await hub.stop();
  });

  it("stops early when the adapter hands back a cursor it already gave", async () => {
    let served = 0;
    const { hub } = await hubWith((request) => {
      if (request.path === "/health") return json(200, HEALTH);
      if (request.path === "/config") return json(200, CONFIG);
      served += 1;
      return json(200, { items: [conversation(`c${served}`)], nextCursor: "again" });
    });
    await hub.test("chat");
    const result = await hub.getAllPages<{ readonly id: string }>(
      "chat",
      "/conversations",
      Conversation,
      { maxPages: 10 },
    );
    expect(result.complete).toBe(false);
    expect(result.items.map((item) => item.id)).toEqual(["c1", "c2"]);
    await hub.stop();
  });

  it("skips an item that does not decode and keeps the rest of the page", async () => {
    const { hub } = await hubWith((request) => {
      if (request.path === "/health") return json(200, HEALTH);
      if (request.path === "/config") return json(200, CONFIG);
      return json(200, {
        items: [
          conversation("good"),
          { ...conversation("no-zone"), lastActivityAt: "2026-11-14 08:00" },
          { id: "missing-fields" },
        ],
        nextCursor: null,
      });
    });
    await hub.test("chat");
    const result = await hub.getAllPages<{ readonly id: string }>(
      "chat",
      "/conversations",
      Conversation,
      { maxPages: 1 },
    );
    expect(result.items.map((item) => item.id)).toEqual(["good"]);
    expect(result.skipped).toBe(2);
    // A page whose envelope is wrong still fails as a whole.
    const { hub: broken } = await hubWith((request) =>
      request.path === "/health"
        ? json(200, HEALTH)
        : request.path === "/config"
          ? json(200, CONFIG)
          : json(200, { items: "nope" }),
    );
    await broken.test("chat");
    await expect(
      broken.getAllPages("chat", "/conversations", Conversation, { maxPages: 1 }),
    ).rejects.toThrow(/does not match protocol/);
    await hub.stop();
    await broken.stop();
  });
});

describe("ChannelHub token redaction", () => {
  it("never hands the token to the browser when the adapter echoes it", async () => {
    const token = "secret-token";
    const { hub } = await hubWith((request) => {
      if (request.path === "/health") {
        return json(200, { ...HEALTH, loggedIn: false, lastError: `bad session ${token}` });
      }
      if (request.path === "/config") {
        return json(200, { ...CONFIG, relevanceSummary: `uses ${token}` });
      }
      return json(500, { error: { code: "unknown", message: `rejected ${token}` } });
    });
    const view = await hub.test("chat");
    expect(view.status).toBe("needs_login");
    expect(JSON.stringify(view)).not.toContain(token);
    const probe = await hub.probe({ baseUrl: view.baseUrl, tokenFile: view.tokenFile });
    expect(JSON.stringify(probe)).not.toContain(token);
    expect(JSON.stringify(hub.list())).not.toContain(token);
    const failure = await hub
      .getJson("chat", "/conversations", RawPage)
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(
      JSON.stringify({ ...(failure as object), message: (failure as Error).message }),
    ).not.toContain(token);
    await hub.stop();
  });

  it("redacts a token echoed in a send answer", async () => {
    const { hub } = await hubWith((request) => {
      if (request.path === "/health") return json(200, HEALTH);
      if (request.path === "/config") return json(200, CONFIG);
      return json(200, { messageId: "secret-token" });
    });
    await hub.test("chat");
    expect(await hub.postJson("chat", "/messages", {})).toEqual({ messageId: "***" });
    await hub.stop();
  });

  it("tells the browser only which channel changed, never the adapter's ids", async () => {
    const dir = await tempDir();
    const tokenFile = NodePath.join(dir, "token");
    await NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 });
    let delivered!: () => void;
    const eventDelivered = new Promise<void>((resolve) => (delivered = resolve));
    const hub = await createTestHub({
      configPath: NodePath.join(dir, "channels.json"),
      transportFor: () => ({
        request: async (request) => json(200, request.path === "/health" ? HEALTH : CONFIG),
        events: (_token, onEvent) => {
          onEvent({ type: "message.created" });
          delivered();
          return new Promise(() => undefined);
        },
      }),
    });
    const events: unknown[] = [];
    hub.subscribe((event) => events.push(event));
    await hub.start();
    await hub.save(
      {
        id: "chat",
        kind: "http-adapter",
        name: "Chat",
        baseUrl: "http://127.0.0.1:7341",
        tokenFile,
        enabled: true,
      },
      { create: true },
    );
    await eventDelivered;
    expect(events).toContainEqual({ type: "inbox", channelId: "chat" });
    expect(JSON.stringify(events)).not.toContain("secret-token");
    await hub.stop();
  });

  it("redacts a token echoed in an unreachable error", async () => {
    const { hub } = await hubWith(() => {
      throw new AdapterUnreachableError({ message: "connect to secret-token failed" });
    });
    expect(JSON.stringify(await hub.test("chat"))).not.toContain("secret-token");
    await hub.stop();
  });
});

async function delivered(hub: Awaited<ReturnType<typeof createTestHub>>, send: () => void) {
  const result = Promise.withResolvers<void>();
  const stop = hub.subscribe((event) => {
    if (event.type === "inbox") result.resolve();
  });
  try {
    send();
    await result.promise;
  } finally {
    stop();
  }
}

describe("ChannelHub events", () => {
  async function streamingHub() {
    const asked: string[] = [];
    let send!: (event: ChannelEvent) => void;
    let opened!: () => void;
    const streamOpen = new Promise<void>((resolve) => (opened = resolve));
    const dir = await tempDir();
    const tokenFile = NodePath.join(dir, "token");
    await NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 });
    const hub = await createTestHub({
      configPath: NodePath.join(dir, "channels.json"),
      transportFor: () => ({
        request: async (request) => {
          if (request.path === "/health") return json(200, HEALTH);
          if (request.path === "/config") return json(200, CONFIG);
          asked.push(request.path);
          return json(200, { items: [], nextCursor: null });
        },
        events: (_token, onEvent) => {
          send = onEvent;
          opened();
          return new Promise(() => undefined);
        },
      }),
    });
    await hub.start();
    await hub.save(
      {
        id: "chat",
        kind: "http-adapter",
        name: "Chat",
        baseUrl: "http://127.0.0.1:7341",
        tokenFile,
        enabled: true,
      },
      { create: true },
    );
    await streamOpen;
    return { hub, asked, send: (event: ChannelEvent) => delivered(hub, () => send(event)) };
  }

  it("reads again only the conversation an event names", async () => {
    const { hub, asked, send } = await streamingHub();
    const paths = [
      "/conversations?relevant=1",
      "/conversations/c%201/messages?order=desc",
      "/conversations/c%201/messages?root=t",
      "/conversations/c2/messages?order=desc",
      "/conversations/c2/messages?root=t",
    ];
    const readAll = () => Promise.all(paths.map((path) => hub.getJson("chat", path, RawPage)));
    await readAll();
    asked.length = 0;
    await send({ type: "message.created", conversationId: "c 1" });
    await readAll();
    expect(asked).toEqual(paths.slice(0, 3));
    asked.length = 0;
    await send({ type: "conversation.updated", conversationId: "c2" });
    await readAll();
    expect(asked).toEqual([paths[0], ...paths.slice(3)]);
    asked.length = 0;
    await send({ type: "conversation.updated" });
    await readAll();
    expect(asked).toEqual(paths);
    await hub.stop();
  });

  it("reads lists again once the event stream (re)connects", async () => {
    let listed = 0;
    let send!: (event: ChannelEvent) => void;
    let opened!: () => void;
    const streamOpen = new Promise<void>((resolve) => (opened = resolve));
    const dir = await tempDir();
    const tokenFile = NodePath.join(dir, "token");
    await NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 });
    const hub = await createTestHub({
      configPath: NodePath.join(dir, "channels.json"),
      transportFor: () => ({
        request: async (request) => {
          if (request.path === "/health") return json(200, HEALTH);
          if (request.path === "/config") return json(200, CONFIG);
          listed += 1;
          return json(200, { items: [], nextCursor: null });
        },
        events: (_token, onEvent) => {
          send = onEvent;
          opened();
          return new Promise(() => undefined);
        },
      }),
    });
    await hub.start();
    await hub.save(
      {
        id: "chat",
        kind: "http-adapter",
        name: "Chat",
        baseUrl: "http://127.0.0.1:7341",
        tokenFile,
        enabled: true,
      },
      { create: true },
    );
    await streamOpen;
    await hub.getJson("chat", "/conversations", RawPage);
    await hub.getJson("chat", "/conversations", RawPage);
    expect(listed).toBe(1);
    await delivered(hub, () => send({ type: "connected" }));
    await hub.getJson("chat", "/conversations", RawPage);
    expect(listed).toBe(2);
    await hub.stop();
  });
});

describe("example channel simulation", () => {
  it("lists conversations newest first, so a capped read keeps the latest", async () => {
    const dir = await tempDir();
    const hub = await createTestHub({
      configPath: NodePath.join(dir, "channels.json"),
      background: false,
    });
    await hub.start();
    await hub.save(
      {
        id: "example",
        kind: "example",
        name: "Example",
        baseUrl: "",
        tokenFile: "",
        enabled: true,
      },
      { create: false },
    );
    const conversations = await hub.getAllPages("example", "/conversations", Conversation, {
      maxPages: 1,
    });
    expect(conversations.complete).toBe(false);
    const all = await hub.getAllPages("example", "/conversations", Conversation, {
      maxPages: 20,
    });
    expect(all).toMatchObject({ complete: true, skipped: 0 });
    const newest = all.items.toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    expect(conversations.items).toEqual(newest.slice(0, conversations.items.length));
    for (const conversation of all.items) {
      const messages = await hub.getAllPages(
        "example",
        `/conversations/${conversation.id}/messages?order=desc`,
        Message,
        { maxPages: 20 },
      );
      expect(messages.skipped).toBe(0);
      expect(messages.items[0]?.id).toBe(conversation.lastMessage?.id);
    }
    await hub.stop();
  });

  it.each([
    ["needs_login", "needs_login"],
    ["collector_stopped", "collector_stopped"],
    ["unreachable", "unreachable"],
    ["incompatible", "incompatible"],
    ["online", "online"],
  ] as const)("simulates %s", async (simulation, status) => {
    const dir = await tempDir();
    const hub = await createTestHub({
      configPath: NodePath.join(dir, "channels.json"),
      background: false,
    });
    await hub.start();
    await hub.save(
      {
        id: "example",
        kind: "example",
        name: "Example",
        baseUrl: "",
        tokenFile: "",
        enabled: true,
      },
      { create: false },
    );
    const view = await hub.simulate("example", simulation);
    expect(view.status).toBe(status);
    expect(view.simulation).toBe(simulation);
    // Health from another protocol means nothing; the channel shows none.
    if (status === "incompatible") expect(view.health).toBeNull();
    await hub.stop();
  });

  it("keeps what was read when the adapter goes away", async () => {
    const dir = await tempDir();
    const hub = await createTestHub({
      configPath: NodePath.join(dir, "channels.json"),
      background: false,
    });
    await hub.start();
    await hub.save(
      {
        id: "example",
        kind: "example",
        name: "Example",
        baseUrl: "",
        tokenFile: "",
        enabled: true,
      },
      { create: false },
    );
    const schema = RawPage;
    const fresh = await hub.getJson("example", "/conversations", schema);
    await hub.simulate("example", "unreachable");
    const stale = await hub.getJson("example", "/conversations", schema);
    expect(stale).toEqual({ value: fresh.value, stale: true });
    expect(channelAccess(hub.get("example")!.status).send).toBe(false);
    await hub.stop();
  });
});

describe("nextCheckDelay", () => {
  it("retries an unreachable adapter sooner, backing off to the usual interval", () => {
    let retryMs: number | null = null;
    const delays: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const next = nextCheckDelay("unreachable", retryMs);
      delays.push(next.delayMs);
      retryMs = next.retryMs;
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 30_000, 30_000]);
    // Back online: the usual interval, and the next outage starts over at 5 seconds.
    const online = nextCheckDelay("online", retryMs);
    expect(online).toEqual({ delayMs: 30_000, retryMs: null });
    expect(nextCheckDelay("unreachable", online.retryMs).delayMs).toBe(5_000);
  });
});

describe("channel access", () => {
  it("matches the status table", () => {
    expect(channelAccess("online")).toEqual({ read: true, send: true, stale: false });
    expect(channelAccess("collector_stopped")).toEqual({ read: true, send: true, stale: false });
    expect(channelAccess("needs_login")).toEqual({ read: true, send: false, stale: false });
    expect(channelAccess("unreachable")).toEqual({ read: true, send: false, stale: true });
    for (const status of ["disabled", "token_missing", "unauthorized", "incompatible"] as const) {
      expect(channelAccess(status).read).toBe(false);
    }
  });
});

describe("validateLoopbackBaseUrl", () => {
  it.each([
    ["http://127.0.0.1:7341/", "http://127.0.0.1:7341"],
    ["http://localhost:80/api/", "http://localhost/api"],
    ["http://[::1]:9000", "http://[::1]:9000"],
  ])("accepts %s", (raw, expected) => {
    expect(validateLoopbackBaseUrl(raw)).toBe(expected);
  });

  it.each([
    "http://10.0.0.5:7341",
    "http://example.com",
    "http://127.0.0.1.nip.io",
    "file:///etc/passwd",
    "http://user:pw@127.0.0.1:1",
    "127.0.0.1:7341",
  ])("refuses %s", (raw) => {
    expect(() => validateLoopbackBaseUrl(raw)).toThrow(ChannelConfigError);
  });

  it("refuses a hand-edited channels.json that points away from this machine", async () => {
    const dir = await tempDir();
    const file = NodePath.join(dir, "channels.json");
    const entry = {
      id: "chat",
      kind: "http-adapter",
      name: "Chat",
      baseUrl: "http://10.0.0.5:7341",
      tokenFile: "",
      enabled: true,
    };
    await NodeFSP.writeFile(file, JSON.stringify({ version: 1, channels: [entry] }));
    await expect(readChannelsFile(file)).rejects.toThrow(/10\.0\.0\.5|this machine/);
    await NodeFSP.writeFile(
      file,
      JSON.stringify({ version: 1, channels: [{ ...entry, baseUrl: "http://[::1]:7341" }] }),
    );
    expect((await readChannelsFile(file)).channels.map((channel) => channel.id)).toEqual([
      "example",
      "chat",
    ]);
  });

  it("builds no HTTP transport for a non-loopback address", () => {
    expect(() => httpTransport("http://10.0.0.5:7341")).toThrow(ChannelConfigError);
    expect(() => httpTransport("http://localhost.evil.com")).toThrow(ChannelConfigError);
  });

  it("sends localhost requests to 127.0.0.1, not to whatever localhost resolves to", async () => {
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await httpTransport("http://localhost:7341/api").request({
        method: "GET",
        path: "/health",
        token: null,
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(urls).toEqual(["http://127.0.0.1:7341/api/health"]);
  });
});

describe("token reader", () => {
  it("invalidates equal-size tokens when only fractional mtime changes", async () => {
    const dir = await tempDir();
    try {
      const file = NodePath.join(dir, "token");
      const read = createTokenReader();
      await NodeFSP.writeFile(file, "one", { mode: 0o600 });
      await NodeFSP.utimes(file, 1, 1.0001);
      const before = await NodeFSP.stat(file);
      expect(await read(file)).toEqual({ ok: true, token: "one", warning: null });
      await NodeFSP.writeFile(file, "two");
      await NodeFSP.utimes(file, 1, 1.0002);
      const after = await NodeFSP.stat(file);
      expect(before.mtime.getTime()).toBe(after.mtime.getTime());
      expect(before.mtimeMs).not.toBe(after.mtimeMs);
      expect(await read(file)).toEqual({ ok: true, token: "two", warning: null });
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a trimmed token, warns on loose permissions, and explains failures", async () => {
    const dir = await tempDir();
    const read = createTokenReader();
    const file = NodePath.join(dir, "token");
    await NodeFSP.writeFile(file, "  abc  \n", { mode: 0o600 });
    expect(await read(file)).toEqual({ ok: true, token: "abc", warning: null });
    await NodeFSP.chmod(file, 0o644);
    await NodeFSP.writeFile(file, "def\n");
    const loose = await read(file);
    expect(loose.ok && loose.token).toBe("def");
    expect(loose.ok && loose.warning).toMatch(/chmod 600/);
    await NodeFSP.writeFile(file, "\n");
    expect((await read(file)).ok).toBe(false);
    expect(await read(NodePath.join(dir, "missing"))).toMatchObject({ ok: false });
    expect(await read("relative/token")).toMatchObject({ ok: false });
    expect(await read("")).toMatchObject({ ok: false });
  });
});

describe("SSE parsing", () => {
  it("splits frames across chunks and decodes known events", () => {
    const frames: Array<[string, string]> = [];
    const parse = createSseParser((event, data) => frames.push([event, data]));
    parse('event: message.created\ndata: {"conversationId":"c",');
    parse('"messageId":"m"}\n\n: ping\n\nevent: health.changed\ndata: {}\n\n');
    expect(frames.map(([event, data]) => parseChannelEvent(event, data))).toEqual([
      { type: "message.created", conversationId: "c" },
      { type: "health.changed" },
    ]);
    // A known event counts whatever its data; it only says that something changed.
    expect(parseChannelEvent("message.created", "{bad")).toEqual({ type: "message.created" });
    expect(parseChannelEvent("message.created", "")).toEqual({ type: "message.created" });
    expect(parseChannelEvent("conversation.updated", '{"conversationId":"c"}')).toEqual({
      type: "conversation.updated",
      conversationId: "c",
    });
    expect(parseChannelEvent("conversation.updated", "{}")).toEqual({
      type: "conversation.updated",
    });
    // v1's event is gone; an adapter still sending it changes nothing.
    expect(parseChannelEvent("topic.updated", "{}")).toBeNull();
    expect(parseChannelEvent("other", "{}")).toBeNull();
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["CR", "\r"],
  ])("keeps frames whole with %s line ends split at every byte", (_name, eol) => {
    const stream = [
      "event: health.changed",
      "data: {}",
      "",
      "event: message.created",
      'data: {"conversationId":"c",',
      'data: "messageId":"m"}',
      "",
      "",
    ].join(eol);
    for (let cut = 0; cut <= stream.length; cut++) {
      const frames: Array<[string, string]> = [];
      const parse = createSseParser((event, data) => frames.push([event, data]));
      parse(stream.slice(0, cut));
      parse(stream.slice(cut));
      expect(frames, `cut at ${cut}`).toEqual([
        ["health.changed", "{}"],
        ["message.created", '{"conversationId":"c",\n"messageId":"m"}'],
      ]);
    }
  });
});

const decodeMessage = Schema.decodeUnknownExit(Message);

describe("protocol fixtures", () => {
  // Adapters check their real answers against these; they must decode as this code does.
  const fixture = (name: string) =>
    NodeFSP.readFile(NodePath.join(import.meta.dirname, "fixtures", name), "utf8");
  const decodes = (schema: Schema.Top, value: unknown) =>
    Schema.decodeUnknownExit(schema as Schema.Decoder<unknown>)(value)._tag;

  it.each([
    ["health.json", ChannelHealth],
    ["config.json", AdapterConfig],
    ["send-ok.json", SendResult],
    ["upload-ok.json", Upload],
    ["send-error.json", AdapterError],
  ] as const)("%s decodes", async (name, schema) => {
    expect(decodes(schema, JSON.parse(await fixture(name)))).toBe("Success");
  });

  it.each([
    ["conversations.json", Conversation],
    ["messages.json", Message],
  ] as const)("every item of %s decodes", async (name, schema) => {
    const page = JSON.parse(await fixture(name)) as { items: ReadonlyArray<unknown> };
    expect(decodes(RawPage, page)).toBe("Success");
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) expect(decodes(schema, item)).toBe("Success");
  });

  it("keeps a message whose attachment kind T3 does not know, as a file", () => {
    const message = {
      id: "om_9",
      createdAt: "2026-11-14T10:00:00.000Z",
      author: { id: "ou_sam", name: "Sam Okafor", isSelf: false },
      mentionsSelf: false,
      text: "",
      attachments: [{ key: "file_v3_audio", kind: "audio", name: "voice.opus" }],
      links: [],
    };
    const decoded = decodeMessage(message);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.value.attachments[0]?.kind).toBe("file");
  });

  it("uses a send error code the protocol names", async () => {
    const { error } = JSON.parse(await fixture("send-error.json")) as { error: { code: string } };
    expect(decodes(SendErrorCode, error.code)).toBe("Success");
  });

  it("parses every event in events.sse", async () => {
    const events: unknown[] = [];
    createSseParser((event, data) => events.push(parseChannelEvent(event, data)))(
      await fixture("events.sse"),
    );
    expect(events).toEqual([
      { type: "message.created", conversationId: "oc_platform" },
      { type: "conversation.updated", conversationId: "oc_platform" },
      { type: "health.changed" },
    ]);
  });
});
