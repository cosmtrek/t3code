import { describe, expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as HttpRouter from "effect/http/HttpRouter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Hub from "./channels/hub.ts";
import * as Config from "./channels/config.ts";
import * as Artifacts from "./inbox/artifacts.ts";
import * as InboxRuntime from "./inbox/InboxRuntime.ts";
import * as BotFiles from "./bot/BotFiles.ts";
import * as BotRuntime from "./bot/BotRuntime.ts";
import { routesLayer } from "./http.ts";

const channel: Hub.ChannelView = {
  id: "chat",
  kind: "http-adapter",
  name: "Chat",
  baseUrl: "http://127.0.0.1:7341",
  tokenFile: "/fixture/token",
  enabled: true,
  status: "disabled",
  statusSince: "2026-01-01T00:00:00.000Z",
  lastCheckedAt: null,
  steps: [],
  tokenWarning: null,
  health: null,
  config: null,
  simulation: null,
};
const scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthSettingsWriteScope];
const fixture = Effect.fn("Test.forkHttp")(function* (
  allowed: ReadonlyArray<AuthEnvironmentScope> = scopes,
) {
  const inboxListeners = new Set<(event: Hub.HubEvent) => void>();
  const botListeners = new Set<(event: BotRuntime.BotEvent) => void>();
  const subscribed = Promise.withResolvers<void>();
  const hubLayer = Layer.mock(Hub.ChannelHub)({
    list: () => [channel],
    revision: () => 0,
    get: (id) => (id === channel.id ? channel : null),
    save: () =>
      Effect.fail(
        new Config.ChannelConfigError({ message: "Fixture invalid config.", field: "baseUrl" }),
      ),
    getMedia: () =>
      Effect.succeed({ status: 200, contentType: "image/png", body: new Uint8Array([1, 2, 3]) }),
  });
  const inboxLayer = Layer.effect(
    InboxRuntime.InboxRuntime,
    Effect.gen(function* () {
      const hub = yield* Hub.ChannelHub;
      return {
        hub,
        store: {} as InboxRuntime.InboxRuntime["Service"]["store"],
        channelsDir: "/fixture",
        itemsDir: "/fixture/items",
        subscribe: (listener: (event: Hub.HubEvent) => void) =>
          Effect.sync(() => {
            inboxListeners.add(listener);
            return Effect.sync(() => {
              inboxListeners.delete(listener);
            });
          }),
      };
    }),
  ).pipe(Layer.provide(hubLayer));
  const dependencies = Layer.mergeAll(
    inboxLayer,
    Layer.effect(
      BotRuntime.BotRuntime,
      Effect.gen(function* () {
        return {
          files: yield* BotFiles.BotFiles,
          botsDir: "/fixture/bots",
          cliPath: "/fixture/bots/bin/t3bot",
          ensureCli: Effect.void,
          existingStore: () => null,
          store: Effect.die("The HTTP contract never opens the bot store."),
          active: yield* Latch.make(),
          turnLock: yield* Semaphore.make(1),
          threadStartLock: yield* Semaphore.make(1),
          workThreads: new Map(),
          ownedThreads: new Map(),
          activity: new Map(),
          publish: () => undefined,
          publishActivity: () => undefined,
          subscribe: (listener: (event: BotRuntime.BotEvent) => void) => {
            botListeners.add(listener);
            subscribed.resolve();
            return () => {
              botListeners.delete(listener);
            };
          },
        };
      }),
    ).pipe(Layer.provide(BotFiles.layer.pipe(Layer.provide(NodeServices.layer)))),
    Artifacts.layer.pipe(Layer.provide(NodeServices.layer)),
    Layer.mock(Project.ProjectService)({ listShells: () => Effect.succeed([]) }),
    Layer.mock(ThreadManagement.ThreadManagementService)({}),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/fixture" }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(DocumentText.DocumentText)({}),
    Layer.mock(ServerSettings.ServerSettingsService)({}),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-http-contract-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      authenticateWebSocketUpgrade: () =>
        Effect.succeed({
          sessionId: AuthSessionId.make("contract"),
          subject: "contract",
          method: "bearer-access-token",
          scopes: allowed,
        }),
    }),
    NodeServices.layer,
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    routesLayer.pipe(Layer.provideMerge(dependencies)),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
  const request = (path: string, init?: RequestInit) =>
    Effect.promise(() => handler(new Request(`http://localhost/api/fork${path}`, init)));
  const json = (path: string, input: unknown) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  return { request, json, inboxListeners, botListeners, subscribed: subscribed.promise };
});

describe("fork HTTP contract", () => {
  it.effect("preserves successful JSON, null fields, omitted fields, and ETag revalidation", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const response = yield* h.request("/channels");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(yield* Effect.promise(() => response.json())).toEqual({
        channels: [{ ...channel, projectMatches: [] }],
      });
      const etag = response.headers.get("etag")!;
      expect(etag).toMatch(/^W\/".+"$/);
      const unchanged = yield* h.request("/channels", { headers: { "if-none-match": etag } });
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(yield* Effect.promise(() => unchanged.text())).toBe("");
      const bots = yield* h.request("/bots");
      expect(bots.status).toBe(200);
      expect(yield* Effect.promise(() => bots.json())).toEqual({ bots: [] });
      const overview = yield* h.request("/inbox/overview");
      expect(yield* Effect.promise(() => overview.json())).toEqual({
        channels: [
          {
            id: "chat",
            name: "Chat",
            kind: "http-adapter",
            status: "disabled",
            statusSince: channel.statusSince,
            lastSyncAt: null,
            selfName: null,
            access: { read: false, send: false, stale: false },
            capabilities: [],
            unreadCount: null,
            attention: null,
            error: null,
          },
        ],
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "preserves validation, missing resources, adapter configuration, and bot token failures",
    () =>
      Effect.gen(function* () {
        const h = yield* fixture();
        const cases = [
          [
            yield* h.json("/channels/remove", {}),
            400,
            { code: "bad_request", message: "Name a channel." },
          ],
          [
            yield* h.json("/channels/save", {
              channel: {
                id: "chat",
                kind: "http-adapter",
                name: "Chat",
                baseUrl: "http://127.0.0.1:7341",
                tokenFile: "",
                enabled: false,
              },
            }),
            400,
            { code: "invalid_config", message: "Fixture invalid config.", field: "baseUrl" },
          ],
          [
            yield* h.request("/inbox/conversations?channelId=missing"),
            404,
            { code: "missing", message: "No such channel." },
          ],
          [
            yield* h.request("/bots/bot?botId=missing"),
            404,
            { code: "not_found", message: "That bot does not exist." },
          ],
          [
            yield* h.json("/bots/create", {}),
            400,
            { code: "bad_request", message: "The request is not valid." },
          ],
          [
            yield* h.json("/bots/tool", { bot: "missing", argv: ["help"], stdin: "" }),
            401,
            { code: "unauthorized", message: "This bot's token was not accepted." },
          ],
        ] as const;
        for (const [response, status, body] of cases) {
          expect(response.status).toBe(status);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(yield* Effect.promise(() => response.json())).toEqual(body);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("keeps JSON and upload limits and media response headers", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      for (const body of ["{", JSON.stringify({ payload: "x".repeat(256 * 1024) })]) {
        const response = yield* h.request("/bots/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(400);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          code: "bad_request",
          message: "Send JSON.",
        });
      }
      const large = yield* h.request("/inbox/upload?channelId=chat&name=file", {
        method: "POST",
        headers: { "content-length": String(100 * 1024 * 1024 + 1) },
        body: new Uint8Array([1]),
      });
      expect(large.status).toBe(413);
      expect(yield* Effect.promise(() => large.json())).toEqual({
        code: "too_large",
        message: "The file is larger than 100 MB.",
      });
      const media = yield* h.request("/inbox/media?channelId=chat&messageId=m&key=k&name=a.png");
      expect(media.status).toBe(200);
      expect(media.headers.get("content-type")).toContain("image/png");
      expect(media.headers.get("cache-control")).toBe("private, max-age=300");
      expect(media.headers.get("x-content-type-options")).toBe("nosniff");
      expect(media.headers.get("content-security-policy")).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
      expect(media.headers.get("content-disposition")).toBe(
        "attachment; filename=\"a.png\"; filename*=UTF-8''a.png",
      );
      expect(new Uint8Array(yield* Effect.promise(() => media.arrayBuffer()))).toEqual(
        new Uint8Array([1, 2, 3]),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("requires each route's scope before executing its operation", () =>
    Effect.gen(function* () {
      const h = yield* fixture([]);
      for (const [path, method] of [
        ["/channels", "GET"],
        ["/channels/save", "POST"],
        ["/inbox/read", "POST"],
        ["/bots/create", "POST"],
        ["/inbox/events", "GET"],
      ] as const) {
        const response = yield* h.request(path, { method });
        expect(response.status).toBe(403);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("preserves SSE framing and releases both event subscriptions", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const response = yield* h.request("/inbox/events");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
      expect(response.headers.get("x-accel-buffering")).toBe("no");
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => response.body!.getReader()),
        (reader) => Effect.promise(() => reader.cancel()),
      );
      const decoder = new TextDecoder();
      let buffered = "";
      // The heartbeat ticks once as the stream starts, so frames are read past ": ping".
      const read = () =>
        Effect.promise(async () => {
          for (;;) {
            const end = buffered.indexOf("\n\n");
            if (end !== -1) {
              const frame = buffered.slice(0, end + 2);
              buffered = buffered.slice(end + 2);
              if (frame !== ": ping\n\n") return frame;
              continue;
            }
            const chunk = await reader.read();
            if (chunk.done) return buffered;
            buffered += decoder.decode(chunk.value, { stream: true });
          }
        });
      expect(yield* read()).toBe(": open\n\n");
      yield* Effect.promise(() => h.subscribed);
      for (const listener of h.inboxListeners) listener({ type: "inbox", channelId: "chat" });
      expect(yield* read()).toBe('data: {"type":"inbox","channelId":"chat"}\n\n');
      for (const listener of h.botListeners) listener({ type: "bots", botId: "bot" });
      expect(yield* read()).toBe('data: {"type":"bots","botId":"bot"}\n\n');
      yield* Effect.promise(() => reader.cancel());
      expect(h.inboxListeners.size).toBe(0);
      expect(h.botListeners.size).toBe(0);
    }).pipe(Effect.scoped),
  );
});
