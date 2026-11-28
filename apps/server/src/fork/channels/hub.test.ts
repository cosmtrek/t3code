import { adapt, type LegacyTransport as ChannelTransport } from "./channelTestkit.ts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Hub from "./hub.ts";
import * as Config from "./config.ts";
import * as Transport from "./transport.ts";
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

const testLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
const thrown = (error: unknown) => () => {
  throw error;
};
const createTestHub = Effect.fn("Test.createHub")(function* (
  options: Omit<Hub.ChannelHubOptions, "transportFor"> & {
    readonly transportFor?: (entry: Config.ChannelConfigEntry) => ChannelTransport;
  },
) {
  const { transportFor, ...settings } = options;
  return yield* Hub.make({
    ...settings,
    ...(transportFor
      ? {
          transportFor: (entry: Config.ChannelConfigEntry) =>
            Effect.succeed(adapt(transportFor(entry))),
        }
      : {}),
  });
});
const readChannelsFile = Config.readChannelsFile;
const createTokenReader = Config.createTokenReader;
const httpTransport = Transport.httpTransport;

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

const tempDir = Effect.fn("Test.tempDir")(function* () {
  return yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-channels-"))),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

const hubWith = Effect.fn("Test.hubWith")(function* (
  handle: (request: AdapterRequest) => AdapterResponse,
  entry: Partial<ChannelConfigEntry> = {},
) {
  const dir = yield* tempDir();
  const tokenFile = NodePath.join(dir, "token");
  yield* Effect.promise(() => NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 }));
  const hub = yield* createTestHub({
    configPath: NodePath.join(dir, "channels.json"),
    transportFor: () => fakeTransport(handle),
    background: false,
  });
  yield* hub.start();
  yield* hub.save(
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
});

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

  it.effect.each(cases)("reports $name", (testCase) =>
    Effect.gen(function* () {
      const { hub } = yield* hubWith(testCase.handle, testCase.entry);
      const view = yield* hub.test("chat");
      expect(view.status).toBe(testCase.status);
      expect(view.steps.find((step) => !step.ok)?.id ?? null).toBe(testCase.failedStep);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("serves the last answer while the adapter is unreachable", () =>
    Effect.gen(function* () {
      let up = true;
      const { hub } = yield* hubWith((request) => {
        if (!up) throw new AdapterUnreachableError({ message: "down" });
        if (request.path === "/health") return json(200, HEALTH);
        if (request.path === "/config") return json(200, CONFIG);
        return json(200, { items: [], nextCursor: null });
      });
      yield* hub.test("chat");
      const schema = RawPage;
      expect((yield* hub.getJson("chat", "/conversations", schema)).stale).toBe(false);
      up = false;
      yield* hub.invalidate("chat");
      yield* hub.test("chat");
      expect(hub.get("chat")?.status).toBe("unreachable");
      expect(yield* hub.getJson("chat", "/conversations", schema)).toEqual({
        value: { items: [], nextCursor: null },
        stale: true,
      });
      expect(
        thrown(
          yield* hub.postJson("chat", "/messages", {}).pipe(
            Effect.match({
              onSuccess: () => expect.fail("Expected failure"),
              onFailure: (error) => error,
            }),
          ),
        ),
      ).toThrow();
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shares one adapter request among concurrent reads of a path, success or failure", () =>
    Effect.gen(function* () {
      let listed = 0;
      let failing = false;
      const { hub } = yield* hubWith((request) => {
        if (request.path === "/health") return json(200, HEALTH);
        if (request.path === "/config") return json(200, CONFIG);
        listed += 1;
        return failing
          ? json(500, { error: { code: "broken", message: "no" } })
          : json(200, { items: [], nextCursor: null });
      });
      yield* hub.test("chat");
      const readAll = () =>
        Effect.all(
          Array.from({ length: 5 }, () =>
            hub.getJson("chat", "/conversations", RawPage).pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        );
      expect(
        (yield* readAll()).map((result) => (Result.isSuccess(result) ? "fulfilled" : "rejected")),
      ).toEqual(Array(5).fill("fulfilled"));
      expect(listed).toBe(1);
      yield* hub.invalidate("chat");
      failing = true;
      const failed = yield* readAll();
      expect(failed.map((result) => (Result.isSuccess(result) ? "fulfilled" : "rejected"))).toEqual(
        Array(5).fill("rejected"),
      );
      expect(
        new Set(failed.map((result) => (Result.isFailure(result) ? result.failure : undefined)))
          .size,
      ).toBe(1);
      expect(listed).toBe(2);
      // A failure is not cached.
      yield* hub.getJson("chat", "/conversations", RawPage).pipe(Effect.ignore);
      expect(listed).toBe(3);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("announces a moved lastSyncAt as a sync, not as changed lists", () =>
    Effect.gen(function* () {
      let lastSyncAt = HEALTH.lastSyncAt;
      const { hub } = yield* hubWith(
        (request) => json(200, request.path === "/health" ? { ...HEALTH, lastSyncAt } : CONFIG),
        {},
      );
      yield* hub.test("chat");
      const events: unknown[] = [];
      yield* Effect.acquireRelease(
        hub.subscribe((event) => events.push(event)),
        (stop) => stop,
      ).pipe(Effect.asVoid);
      yield* hub.test("chat");
      expect(events).toEqual([]);
      lastSyncAt = "2026-11-14T08:05:00.000Z";
      yield* hub.test("chat");
      expect(events).toEqual([{ type: "sync", channelId: "chat" }]);
      expect(hub.get("chat")?.health?.lastSyncAt).toBe(lastSyncAt);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps ids stable and refuses duplicates", () =>
    Effect.gen(function* () {
      const { hub } = yield* hubWith((request) =>
        json(200, request.path === "/health" ? HEALTH : CONFIG),
      );
      expect(
        yield* hub
          .save(
            {
              id: "chat",
              kind: "http-adapter",
              name: "Again",
              baseUrl: "http://127.0.0.1:1",
              tokenFile: "",
              enabled: false,
            },
            { create: true },
          )
          .pipe(
            Effect.match({
              onSuccess: () => expect.fail("Expected failure"),
              onFailure: (error) => error,
            }),
          ),
      ).toBeInstanceOf(ChannelConfigError);
      const added = yield* hub.save(
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
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps the example channel: it cannot be removed or added again", () =>
    Effect.gen(function* () {
      const { hub } = yield* hubWith((request) =>
        json(200, request.path === "/health" ? HEALTH : CONFIG),
      );
      expect(
        yield* hub.remove("example").pipe(
          Effect.match({
            onSuccess: () => expect.fail("Expected failure"),
            onFailure: (error) => error,
          }),
        ),
      ).toBeInstanceOf(ChannelConfigError);
      expect(
        yield* hub
          .save(
            { id: "", kind: "example", name: "Again", baseUrl: "", tokenFile: "", enabled: true },
            { create: true },
          )
          .pipe(
            Effect.match({
              onSuccess: () => expect.fail("Expected failure"),
              onFailure: (error) => error,
            }),
          ),
      ).toBeInstanceOf(ChannelConfigError);
      expect(hub.list().map((channel) => channel.id)).toEqual(["example", "chat"]);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("checks an adapter that is not saved yet, and keeps nothing of it", () =>
    Effect.gen(function* () {
      const { hub, dir } = yield* hubWith((request) =>
        json(200, request.path === "/health" ? HEALTH : CONFIG),
      );
      const probe = yield* hub.probe({
        baseUrl: "http://127.0.0.1:7342/",
        tokenFile: NodePath.join(dir, "token"),
      });
      expect(probe.status).toBe("online");
      expect(probe.config?.displayName).toBe("Chat");
      expect(
        yield* hub.probe({ baseUrl: "http://10.0.0.5:7341", tokenFile: "" }).pipe(
          Effect.match({
            onSuccess: () => expect.fail("Expected failure"),
            onFailure: (error) => error,
          }),
        ),
      ).toBeInstanceOf(ChannelConfigError);
      expect(hub.list().map((channel) => channel.id)).toEqual(["example", "chat"]);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
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

  it.effect.each([
    ["conversations", "/conversations?relevant=1", Conversation, conversation],
    ["messages", "/conversations/c/messages?root=t", Message, message],
  ] as const)("follows nextCursor through every page of %s", ([_name, path, schema, make]) =>
    Effect.gen(function* () {
      const asked: string[] = [];
      const { hub } = yield* hubWith((request) => {
        if (request.path === "/health") return json(200, HEALTH);
        if (request.path === "/config") return json(200, CONFIG);
        asked.push(request.path);
        return request.path.includes("cursor=p%202")
          ? json(200, { items: [make("b")], nextCursor: null })
          : json(200, { items: [make("a")], nextCursor: "p 2" });
      });
      yield* hub.test("chat");
      const result = yield* hub.getAllPages<{ readonly id: string }>("chat", path, schema, {
        maxPages: 10,
      });
      expect(result.items.map((item) => item.id)).toEqual(["a", "b"]);
      expect(result.complete).toBe(true);
      expect(asked).toEqual([path, `${path}${path.includes("?") ? "&" : "?"}cursor=p%202`]);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops after maxPages when the adapter never ends the list", () =>
    Effect.gen(function* () {
      let served = 0;
      const { hub } = yield* hubWith((request) => {
        if (request.path === "/health") return json(200, HEALTH);
        if (request.path === "/config") return json(200, CONFIG);
        served += 1;
        return json(200, { items: [], nextCursor: `n${served}` });
      });
      yield* hub.test("chat");
      const result = yield* hub.getAllPages("chat", "/conversations", Conversation, {
        maxPages: 3,
      });
      expect(result.complete).toBe(false);
      expect(served).toBe(3);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops early when the adapter hands back a cursor it already gave", () =>
    Effect.gen(function* () {
      let served = 0;
      const { hub } = yield* hubWith((request) => {
        if (request.path === "/health") return json(200, HEALTH);
        if (request.path === "/config") return json(200, CONFIG);
        served += 1;
        return json(200, { items: [conversation(`c${served}`)], nextCursor: "again" });
      });
      yield* hub.test("chat");
      const result = yield* hub.getAllPages<{ readonly id: string }>(
        "chat",
        "/conversations",
        Conversation,
        { maxPages: 10 },
      );
      expect(result.complete).toBe(false);
      expect(result.items.map((item) => item.id)).toEqual(["c1", "c2"]);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("skips an item that does not decode and keeps the rest of the page", () =>
    Effect.gen(function* () {
      const { hub } = yield* hubWith((request) => {
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
      yield* hub.test("chat");
      const result = yield* hub.getAllPages<{ readonly id: string }>(
        "chat",
        "/conversations",
        Conversation,
        { maxPages: 1 },
      );
      expect(result.items.map((item) => item.id)).toEqual(["good"]);
      expect(result.skipped).toBe(2);
      // A page whose envelope is wrong still fails as a whole.
      const { hub: broken } = yield* hubWith((request) =>
        request.path === "/health"
          ? json(200, HEALTH)
          : request.path === "/config"
            ? json(200, CONFIG)
            : json(200, { items: "nope" }),
      );
      yield* broken.test("chat");
      expect(
        thrown(
          yield* broken.getAllPages("chat", "/conversations", Conversation, { maxPages: 1 }).pipe(
            Effect.match({
              onSuccess: () => expect.fail("Expected failure"),
              onFailure: (error) => error,
            }),
          ),
        ),
      ).toThrow(/does not match protocol/);
      yield* hub.stop();
      yield* broken.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("ChannelHub token redaction", () => {
  it.effect("never hands the token to the browser when the adapter echoes it", () =>
    Effect.gen(function* () {
      const token = "secret-token";
      const { hub } = yield* hubWith((request) => {
        if (request.path === "/health") {
          return json(200, { ...HEALTH, loggedIn: false, lastError: `bad session ${token}` });
        }
        if (request.path === "/config") {
          return json(200, { ...CONFIG, relevanceSummary: `uses ${token}` });
        }
        return json(500, { error: { code: "unknown", message: `rejected ${token}` } });
      });
      const view = yield* hub.test("chat");
      expect(view.status).toBe("needs_login");
      expect(JSON.stringify(view)).not.toContain(token);
      const probe = yield* hub.probe({ baseUrl: view.baseUrl, tokenFile: view.tokenFile });
      expect(JSON.stringify(probe)).not.toContain(token);
      expect(JSON.stringify(hub.list())).not.toContain(token);
      const failure = yield* hub
        .getJson("chat", "/conversations", RawPage)
        .pipe(Effect.catch((error) => Effect.succeed(error)));
      expect(failure).toBeInstanceOf(Error);
      expect(
        JSON.stringify({ ...(failure as object), message: (failure as Error).message }),
      ).not.toContain(token);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("redacts a token echoed in a send answer", () =>
    Effect.gen(function* () {
      const { hub } = yield* hubWith((request) => {
        if (request.path === "/health") return json(200, HEALTH);
        if (request.path === "/config") return json(200, CONFIG);
        return json(200, { messageId: "secret-token" });
      });
      yield* hub.test("chat");
      expect(yield* hub.postJson("chat", "/messages", {})).toEqual({ messageId: "***" });
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("tells the browser only which channel changed, never the adapter's ids", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const tokenFile = NodePath.join(dir, "token");
      yield* Effect.promise(() => NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 }));
      let delivered!: () => void;
      const eventDelivered = new Promise<void>((resolve) => (delivered = resolve));
      const hub = yield* createTestHub({
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
      yield* Effect.acquireRelease(
        hub.subscribe((event) => events.push(event)),
        (stop) => stop,
      ).pipe(Effect.asVoid);
      yield* hub.start();
      yield* hub.save(
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
      yield* Effect.promise(() => eventDelivered);
      expect(events).toContainEqual({ type: "inbox", channelId: "chat" });
      expect(JSON.stringify(events)).not.toContain("secret-token");
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("redacts a token echoed in an unreachable error", () =>
    Effect.gen(function* () {
      const { hub } = yield* hubWith(() => {
        throw new AdapterUnreachableError({ message: "connect to secret-token failed" });
      });
      expect(JSON.stringify(yield* hub.test("chat"))).not.toContain("secret-token");
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

const delivered = Effect.fn("Test.delivered")(function* (
  hub: Hub.ChannelHub["Service"],
  send: () => void,
) {
  const result = Promise.withResolvers<void>();
  const stop = yield* hub.subscribe((event) => {
    if (event.type === "inbox") result.resolve();
  });
  try {
    send();
    yield* Effect.promise(() => result.promise);
  } finally {
    yield* stop;
  }
});

describe("ChannelHub events", () => {
  const streamingHub = Effect.fn("Test.streamingHub")(function* () {
    const asked: string[] = [];
    let send!: (event: ChannelEvent) => void;
    let opened!: () => void;
    const streamOpen = new Promise<void>((resolve) => (opened = resolve));
    const dir = yield* tempDir();
    const tokenFile = NodePath.join(dir, "token");
    yield* Effect.promise(() => NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 }));
    const hub = yield* createTestHub({
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
    yield* hub.start();
    yield* hub.save(
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
    yield* Effect.promise(() => streamOpen);
    return { hub, asked, send: (event: ChannelEvent) => delivered(hub, () => send(event)) };
  });

  it.effect("reads again only the conversation an event names", () =>
    Effect.gen(function* () {
      const { hub, asked, send } = yield* streamingHub();
      const paths = [
        "/conversations?relevant=1",
        "/conversations/c%201/messages?order=desc",
        "/conversations/c%201/messages?root=t",
        "/conversations/c2/messages?order=desc",
        "/conversations/c2/messages?root=t",
      ];
      const readAll = () =>
        Effect.forEach(paths, (path) => hub.getJson("chat", path, RawPage), {
          concurrency: "unbounded",
        });
      yield* readAll();
      asked.length = 0;
      yield* send({ type: "message.created", conversationId: "c 1" });
      yield* readAll();
      expect(asked).toEqual(paths.slice(0, 3));
      asked.length = 0;
      yield* send({ type: "conversation.updated", conversationId: "c2" });
      yield* readAll();
      expect(asked).toEqual([paths[0], ...paths.slice(3)]);
      asked.length = 0;
      yield* send({ type: "conversation.updated" });
      yield* readAll();
      expect(asked).toEqual(paths);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reads lists again once the event stream (re)connects", () =>
    Effect.gen(function* () {
      let listed = 0;
      let send!: (event: ChannelEvent) => void;
      let opened!: () => void;
      const streamOpen = new Promise<void>((resolve) => (opened = resolve));
      const dir = yield* tempDir();
      const tokenFile = NodePath.join(dir, "token");
      yield* Effect.promise(() => NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 }));
      const hub = yield* createTestHub({
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
      yield* hub.start();
      yield* hub.save(
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
      yield* Effect.promise(() => streamOpen);
      yield* hub.getJson("chat", "/conversations", RawPage);
      yield* hub.getJson("chat", "/conversations", RawPage);
      expect(listed).toBe(1);
      yield* delivered(hub, () => send({ type: "connected" }));
      yield* hub.getJson("chat", "/conversations", RawPage);
      expect(listed).toBe(2);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("example channel simulation", () => {
  it.effect("lists conversations newest first, so a capped read keeps the latest", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const hub = yield* createTestHub({
        configPath: NodePath.join(dir, "channels.json"),
        background: false,
      });
      yield* hub.start();
      yield* hub.save(
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
      const conversations = yield* hub.getAllPages("example", "/conversations", Conversation, {
        maxPages: 1,
      });
      expect(conversations.complete).toBe(false);
      const all = yield* hub.getAllPages("example", "/conversations", Conversation, {
        maxPages: 20,
      });
      expect(all).toMatchObject({ complete: true, skipped: 0 });
      const newest = all.items.toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      expect(conversations.items).toEqual(newest.slice(0, conversations.items.length));
      for (const conversation of all.items) {
        const messages = yield* hub.getAllPages(
          "example",
          `/conversations/${conversation.id}/messages?order=desc`,
          Message,
          { maxPages: 20 },
        );
        expect(messages.skipped).toBe(0);
        expect(messages.items[0]?.id).toBe(conversation.lastMessage?.id);
      }
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([
    ["needs_login", "needs_login"],
    ["collector_stopped", "collector_stopped"],
    ["unreachable", "unreachable"],
    ["incompatible", "incompatible"],
    ["online", "online"],
  ] as const)("simulates %s", ([simulation, status]) =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const hub = yield* createTestHub({
        configPath: NodePath.join(dir, "channels.json"),
        background: false,
      });
      yield* hub.start();
      yield* hub.save(
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
      const view = yield* hub.simulate("example", simulation);
      expect(view.status).toBe(status);
      expect(view.simulation).toBe(simulation);
      // Health from another protocol means nothing; the channel shows none.
      if (status === "incompatible") expect(view.health).toBeNull();
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps what was read when the adapter goes away", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const hub = yield* createTestHub({
        configPath: NodePath.join(dir, "channels.json"),
        background: false,
      });
      yield* hub.start();
      yield* hub.save(
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
      const fresh = yield* hub.getJson("example", "/conversations", schema);
      yield* hub.simulate("example", "unreachable");
      const stale = yield* hub.getJson("example", "/conversations", schema);
      expect(stale).toEqual({ value: fresh.value, stale: true });
      expect(channelAccess(hub.get("example")!.status).send).toBe(false);
      yield* hub.stop();
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
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

  it.effect("refuses a hand-edited channels.json that points away from this machine", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const file = NodePath.join(dir, "channels.json");
      const entry = {
        id: "chat",
        kind: "http-adapter",
        name: "Chat",
        baseUrl: "http://10.0.0.5:7341",
        tokenFile: "",
        enabled: true,
      };
      yield* Effect.promise(() =>
        NodeFSP.writeFile(file, JSON.stringify({ version: 1, channels: [entry] })),
      );
      expect(
        thrown(
          yield* readChannelsFile(file).pipe(
            Effect.match({
              onSuccess: () => expect.fail("Expected failure"),
              onFailure: (error) => error,
            }),
          ),
        ),
      ).toThrow(/10\.0\.0\.5|this machine/);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          file,
          JSON.stringify({ version: 1, channels: [{ ...entry, baseUrl: "http://[::1]:7341" }] }),
        ),
      );
      expect((yield* readChannelsFile(file)).channels.map((channel) => channel.id)).toEqual([
        "example",
        "chat",
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("builds no HTTP transport for a non-loopback address", () =>
    Effect.gen(function* () {
      for (const base of ["http://10.0.0.5:7341", "http://localhost.evil.com"]) {
        expect(yield* Effect.flip(httpTransport(base))).toBeInstanceOf(ChannelConfigError);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("sends localhost requests to 127.0.0.1, not to whatever localhost resolves to", () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request) => {
        urls.push(String(input));
        return new Response("{}", { status: 200 });
      }) as typeof fetch;
      try {
        yield* (yield* httpTransport("http://localhost:7341/api"))
          .request({
            method: "GET",
            path: "/health",
            token: null,
          })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(urls).toEqual(["http://127.0.0.1:7341/api/health"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("token reader", () => {
  it.effect("invalidates equal-size tokens when only fractional mtime changes", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      try {
        const file = NodePath.join(dir, "token");
        const read = yield* createTokenReader;
        yield* Effect.promise(() => NodeFSP.writeFile(file, "one", { mode: 0o600 }));
        yield* Effect.promise(() => NodeFSP.utimes(file, 1, 1.0001));
        const before = yield* Effect.promise(() => NodeFSP.stat(file));
        expect(yield* read(file)).toEqual({ ok: true, token: "one", warning: null });
        yield* Effect.promise(() => NodeFSP.writeFile(file, "two"));
        yield* Effect.promise(() => NodeFSP.utimes(file, 1, 1.0002));
        const after = yield* Effect.promise(() => NodeFSP.stat(file));
        expect(before.mtime.getTime()).toBe(after.mtime.getTime());
        expect(before.mtimeMs).not.toBe(after.mtimeMs);
        expect(yield* read(file)).toEqual({ ok: true, token: "two", warning: null });
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }));
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reads a trimmed token, warns on loose permissions, and explains failures", () =>
    Effect.gen(function* () {
      const dir = yield* tempDir();
      const read = yield* createTokenReader;
      const file = NodePath.join(dir, "token");
      yield* Effect.promise(() => NodeFSP.writeFile(file, "  abc  \n", { mode: 0o600 }));
      expect(yield* read(file)).toEqual({ ok: true, token: "abc", warning: null });
      yield* Effect.promise(() => NodeFSP.chmod(file, 0o644));
      yield* Effect.promise(() => NodeFSP.writeFile(file, "def\n"));
      const loose = yield* read(file);
      expect(loose.ok && loose.token).toBe("def");
      expect(loose.ok && loose.warning).toMatch(/chmod 600/);
      yield* Effect.promise(() => NodeFSP.writeFile(file, "\n"));
      expect((yield* read(file)).ok).toBe(false);
      expect(yield* read(NodePath.join(dir, "missing"))).toMatchObject({ ok: false });
      expect(yield* read("relative/token")).toMatchObject({ ok: false });
      expect(yield* read("")).toMatchObject({ ok: false });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
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

  it.effect.each([
    ["health.json", ChannelHealth],
    ["config.json", AdapterConfig],
    ["send-ok.json", SendResult],
    ["upload-ok.json", Upload],
    ["send-error.json", AdapterError],
  ] as const)("%s decodes", ([name, schema]) =>
    Effect.gen(function* () {
      expect(decodes(schema, JSON.parse(yield* Effect.promise(() => fixture(name))))).toBe(
        "Success",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([
    ["conversations.json", Conversation],
    ["messages.json", Message],
  ] as const)("every item of %s decodes", ([name, schema]) =>
    Effect.gen(function* () {
      const page = JSON.parse(yield* Effect.promise(() => fixture(name))) as {
        items: ReadonlyArray<unknown>;
      };
      expect(decodes(RawPage, page)).toBe("Success");
      expect(page.items.length).toBeGreaterThan(0);
      for (const item of page.items) expect(decodes(schema, item)).toBe("Success");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

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

  it.effect("uses a send error code the protocol names", () =>
    Effect.gen(function* () {
      const { error } = JSON.parse(yield* Effect.promise(() => fixture("send-error.json"))) as {
        error: { code: string };
      };
      expect(decodes(SendErrorCode, error.code)).toBe("Success");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("parses every event in events.sse", () =>
    Effect.gen(function* () {
      const events: unknown[] = [];
      createSseParser((event, data) => events.push(parseChannelEvent(event, data)))(
        yield* Effect.promise(() => fixture("events.sse")),
      );
      expect(events).toEqual([
        { type: "message.created", conversationId: "oc_platform" },
        { type: "conversation.updated", conversationId: "oc_platform" },
        { type: "health.changed" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
