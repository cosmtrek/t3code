import { adapt, type LegacyTransport as ChannelTransport } from "./channelTestkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Hub from "./hub.ts";
import * as Transport from "./transport.ts";
// @effect-diagnostics nodeBuiltinImport:off - Independent channel configuration and token fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import { type HubEvent } from "./hub.ts";
import { RawPage } from "./protocol.ts";
import type { AdapterResponse } from "./transport.ts";

const testLayer = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
const thrown = (error: unknown) => () => {
  throw error;
};

const health = {
  protocol: 2,
  adapterVersion: "1",
  online: true,
  loggedIn: true,
  lastSyncAt: null,
  self: { name: "Me" },
};
const config = { displayName: "Fixture", defaultProjectPaths: [], relevanceSummary: "All" };
const page = { items: [], nextCursor: null };
const json = (value: unknown): AdapterResponse => ({
  status: 200,
  contentType: "application/json",
  body: new TextEncoder().encode(JSON.stringify(value)),
});

const fixture = Effect.fn("Test.fixture")(function* (
  transport: ChannelTransport,
  background = false,
  example = false,
) {
  const dir = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "channel-lifecycle-"))),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
  const entry = {
    id: "chat",
    name: "Chat",
    kind: example ? ("example" as const) : ("http-adapter" as const),
    enabled: true,
    baseUrl: "http://127.0.0.1:7341",
    tokenFile: NodePath.join(dir, "token"),
  };
  yield* Effect.promise(() =>
    NodeFSP.writeFile(entry.tokenFile, "synthetic-token", { mode: 0o600 }),
  );
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(dir, "channels.json"),
      JSON.stringify({ version: 1, channels: [entry] }),
    ),
  );
  const hub = yield* Hub.make({
    configPath: NodePath.join(dir, "channels.json"),
    transportFor: () => Effect.succeed(adapt(transport)),
    background,
  });
  yield* hub.start();
  return { hub, entry };
});
const httpTransport = Effect.fn("Test.httpTransport")(function* (base: string) {
  const transport = yield* Transport.httpTransport(base);
  const fetch = globalThis.fetch;
  return {
    request: (input: Transport.AdapterRequest): ReturnType<typeof transport.request> =>
      transport.request(input).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
    events: (token: string | null, emit: (event: import("./protocol.ts").ChannelEvent) => void) =>
      transport.events(token).pipe(
        Stream.runForEach((event) => Effect.sync(() => emit(event))),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
  };
});

const changes = ["stop", "remove", "replace"] as const;
const change = Effect.fn("Test.change")(function* (
  h: Effect.Success<ReturnType<typeof fixture>>,
  operation: (typeof changes)[number],
) {
  if (operation === "stop") yield* h.hub.stop();
  else if (operation === "remove") yield* h.hub.remove("chat");
  else yield* h.hub.save({ ...h.entry, enabled: false }, { create: false });
});

function eventTransport(): ChannelTransport {
  return {
    request: async ({ path }) => json(path === "/health" ? health : config),
    events: (_token, _emit, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  };
}

describe("channel cancellation boundaries", () => {
  describe.each(changes)("%s", (operation) => {
    describe.each([false, true])("forced=%s", (force) => {
      it.effect(
        `${operation} cancels a health request${force ? " and a forced check waiting behind it" : ""}`,
        () =>
          Effect.gen(function* () {
            const entered = Promise.withResolvers<void>();
            const answer = Promise.withResolvers<AdapterResponse>();
            let requests = 0;
            const transport = eventTransport();
            const h = yield* fixture({
              ...transport,
              request: ({ path }) => {
                requests++;
                if (path === "/health") {
                  entered.resolve();
                  return answer.promise;
                }
                return Promise.resolve(json(config));
              },
            });
            const published: HubEvent[] = [];
            const checking = yield* Effect.forkScoped(
              h.hub.test("chat").pipe(Effect.catch((error) => Effect.succeed(error))),
            );
            yield* Effect.promise(() => entered.promise);
            const forced = yield* Effect.forkScoped(
              force
                ? h.hub.test("chat").pipe(Effect.catch((error) => Effect.succeed(error)))
                : Effect.void,
            );
            yield* change(h, operation);
            const count = requests;
            yield* Effect.acquireRelease(
              h.hub.subscribe((event) => published.push(event)),
              (stop) => stop,
            ).pipe(Effect.asVoid);
            answer.resolve(json(health));
            yield* Effect.all([Fiber.await(checking), Fiber.await(forced)]);
            expect(published).toEqual([]);
            expect(requests).toBe(count);
          }).pipe(Effect.scoped, Effect.provide(testLayer)),
      );
    });
    it.effect(`${operation} closes the SSE connection and prevents reconnecting`, () =>
      Effect.gen(function* () {
        const connected = Promise.withResolvers<void>();
        const cancelled = Promise.withResolvers<void>();
        let connections = 0;
        const h = yield* fixture(
          {
            ...eventTransport(),
            events: (_token, emit, signal) =>
              new Promise<void>((resolve) => {
                connections++;
                emit({ type: "connected" });
                connected.resolve();
                signal.addEventListener(
                  "abort",
                  () => {
                    cancelled.resolve();
                    resolve();
                  },
                  { once: true },
                );
              }),
          },
          true,
        );
        yield* Effect.promise(() => connected.promise);
        yield* change(h, operation);
        yield* Effect.promise(() => cancelled.promise);
        const revision = h.hub.revision("chat");
        yield* TestClock.adjust(120_000);
        expect(connections).toBe(1);
        expect(h.hub.revision("chat")).toBe(revision);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
    it.effect(`${operation} cancels the event retry and scheduled health check`, () =>
      Effect.gen(function* () {
        const ended = Promise.withResolvers<void>();
        let connections = 0;
        let requests = 0;
        const h = yield* fixture(
          {
            request: async ({ path }) => {
              requests++;
              return json(path === "/health" ? health : config);
            },
            events: async () => {
              connections++;
              ended.resolve();
            },
          },
          true,
        );
        yield* Effect.promise(() => ended.promise);
        yield* TestClock.adjust(0);
        yield* change(h, operation);
        const count = requests;
        const revision = h.hub.revision("chat");
        yield* TestClock.adjust(120_000);
        expect(connections).toBe(1);
        expect(requests).toBe(count);
        expect(h.hub.revision("chat")).toBe(revision);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  });
});

describe("channel cache and scheduling", () => {
  it.effect("expires cached lists at 20 seconds and shares a read after one reader cancels", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<AdapterResponse>();
      let reads = 0;
      const h = yield* fixture({
        ...eventTransport(),
        request: async ({ path }) => {
          if (path === "/health") return json(health);
          if (path === "/config") return json(config);
          reads++;
          if (reads === 2) {
            entered.resolve();
            return answer.promise;
          }
          return json(page);
        },
      });
      yield* h.hub.test("chat");
      expect(yield* h.hub.getJson("chat", "/conversations", RawPage)).toEqual({
        value: page,
        stale: false,
      });
      yield* TestClock.adjust(19_999);
      yield* h.hub.getJson("chat", "/conversations", RawPage);
      expect(reads).toBe(1);
      yield* TestClock.adjust(1);
      const reader = yield* Effect.forkScoped(h.hub.getJson("chat", "/conversations", RawPage));
      yield* Effect.promise(() => entered.promise);
      const other = yield* Effect.forkScoped(h.hub.getJson("chat", "/conversations", RawPage));
      yield* Fiber.interrupt(reader);
      answer.resolve(json(page));
      expect(yield* Fiber.join(other)).toEqual({ value: page, stale: false });
      expect(reads).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("doubles event retry to 60 seconds and resets after a clean connection closes", () =>
    Effect.gen(function* () {
      const first = Promise.withResolvers<void>();
      let connections = 0;
      let healthy = false;
      const _h = yield* fixture(
        {
          ...eventTransport(),
          events: async () => {
            connections++;
            first.resolve();
            if (!healthy) throw new Error("disconnected");
          },
        },
        true,
        true,
      );
      yield* Effect.promise(() => first.promise);
      yield* TestClock.adjust(0);
      for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
        const count = connections;
        yield* TestClock.adjust(delay - 1);
        expect(connections).toBe(count);
        yield* TestClock.adjust(1);
        expect(connections).toBe(count + 1);
      }
      healthy = true;
      yield* TestClock.adjust(60_000);
      const count = connections;
      yield* TestClock.adjust(4_999);
      expect(connections).toBe(count);
      yield* TestClock.adjust(1);
      expect(connections).toBe(count + 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("backs off health checks to 30 seconds and resets after recovery", () =>
    Effect.gen(function* () {
      let up = false;
      let checks = 0;
      const initial = Promise.withResolvers<AdapterResponse>();
      const h = yield* fixture(
        {
          ...eventTransport(),
          request: async ({ path }) => {
            if (path === "/health") {
              checks++;
              if (checks === 1) return initial.promise;
              if (!up) throw new Error("offline");
              return json(health);
            }
            return json(config);
          },
        },
        true,
        true,
      );
      const forced = yield* Effect.forkScoped(h.hub.test("chat"));
      initial.resolve({ ...json({}), status: 503 });
      yield* Fiber.join(forced);
      // A forced check has already consumed the first 5-second backoff.
      for (const delay of [10_000, 20_000, 30_000]) {
        const count = checks;
        yield* TestClock.adjust(delay - 1);
        expect(checks).toBe(count);
        yield* TestClock.adjust(1);
        expect(checks).toBe(count + 1);
      }
      up = true;
      yield* h.hub.test("chat");
      up = false;
      yield* h.hub.test("chat");
      const count = checks;
      yield* TestClock.adjust(4_999);
      expect(checks).toBe(count);
      yield* TestClock.adjust(1);
      expect(checks).toBe(count + 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("HTTP transport boundaries", () => {
  it.effect.each([false, true])("times out requests and response bodies (media=%s)", (media) =>
    Effect.gen(function* () {
      for (const body of [false, true]) {
        const entered = Promise.withResolvers<void>();
        let aborted = false;
        using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
          const signal = init!.signal!;
          if (body)
            return new Response(
              new ReadableStream({
                start(controller) {
                  signal.addEventListener("abort", () => {
                    aborted = true;
                    controller.error(signal.reason);
                  });
                  entered.resolve();
                },
              }),
            );
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            });
            entered.resolve();
          });
        });
        const pending = yield* Effect.forkScoped(
          (yield* httpTransport("http://127.0.0.1:7341"))
            .request({ method: "GET", path: "/media", token: null, media })
            .pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error })),
        );
        yield* Effect.promise(() => entered.promise);
        yield* TestClock.adjust((media ? 120_000 : 10_000) - 1);
        expect(aborted).toBe(false);
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(pending)).toBeInstanceOf(Error);
        expect(aborted).toBe(true);
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([false, true])("enforces declared and actual byte limits (media=%s)", (media) =>
    Effect.gen(function* () {
      const size = (media ? 200 : 25) * 1024 * 1024;
      let cancelled = false;
      using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-length": String(size + 1) } },
        ),
      );
      const transport = yield* httpTransport("http://127.0.0.1:7341");
      expect(
        thrown(
          yield* transport.request({ method: "GET", path: "/media", token: null, media }).pipe(
            Effect.match({
              onSuccess: () => expect.fail("Expected failure"),
              onFailure: (error) => error,
            }),
          ),
        ),
      ).toThrow(`The adapter answered with ${size + 1} bytes, more than allowed.`);
      expect(cancelled).toBe(true);
      _fetch.mockResolvedValue(new Response(new Uint8Array(size + 1)));
      expect(
        thrown(
          yield* transport.request({ method: "GET", path: "/media", token: null, media }).pipe(
            Effect.match({
              onSuccess: () => expect.fail("Expected failure"),
              onFailure: (error) => error,
            }),
          ),
        ),
      ).toThrow("The adapter's answer is larger than allowed.");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects redirects and never retries a POST", () =>
    Effect.gen(function* () {
      using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        expect(init?.redirect).toBe("error");
        throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
      });
      expect(
        thrown(
          yield* (yield* httpTransport("http://localhost:7341"))
            .request({
              method: "POST",
              path: "/messages",
              body: { text: "once" },
              token: "synthetic-token",
            })
            .pipe(
              Effect.match({
                onSuccess: () => expect.fail("Expected failure"),
                onFailure: (error) => error,
              }),
            ),
        ),
      ).toThrow("unexpected redirect");
      expect(_fetch).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each([401, 403])(
    "preserves HTTP %s and rejects an unauthorized event stream",
    (status) =>
      Effect.gen(function* () {
        using _fetch = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async () => new Response("not json", { status }));
        const transport = yield* httpTransport("http://127.0.0.1:7341");
        const response = yield* transport.request({ method: "GET", path: "/health", token: null });
        expect(response.status).toBe(status);
        expect(new TextDecoder().decode(response.body)).toBe("not json");
        const events: unknown[] = [];
        expect(
          thrown(
            yield* transport
              .events(null, (event) => events.push(event))
              .pipe(
                Effect.match({
                  onSuccess: () => expect.fail("Expected failure"),
                  onFailure: (error) => error,
                }),
              ),
          ),
        ).toThrow(`The adapter's event stream answered ${status}.`);
        expect(events).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("decodes split UTF-8 and SSE frames then reports a stream interruption", () =>
    Effect.gen(function* () {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          new ReadableStream({
            start(value) {
              controller = value;
            },
          }),
        ),
      );
      const connected = Promise.withResolvers<void>();
      const delivered = Promise.withResolvers<void>();
      const events: unknown[] = [];
      const pending = yield* Effect.forkScoped(
        (yield* httpTransport("http://127.0.0.1:7341"))
          .events(null, (event) => {
            events.push(event);
            if (event.type === "connected") connected.resolve();
            else delivered.resolve();
          })
          .pipe(Effect.catch((error) => Effect.succeed(error))),
      );
      yield* Effect.promise(() => connected.promise);
      const bytes = new TextEncoder().encode(
        'event: message.created\ndata: {"conversationId":"中文"}\n\n',
      );
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      yield* Effect.promise(() => delivered.promise);
      controller.error(new Error("stream interrupted"));
      expect(yield* Fiber.join(pending)).toBeInstanceOf(Error);
      expect(((yield* Fiber.join(pending)) as Error).message).toBe("stream interrupted");
      expect(events).toEqual([
        { type: "connected" },
        { type: "message.created", conversationId: "中文" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  // Regression for the token-bearing transport/body failures recorded in the baseline.
  it.effect("redacts tokens from transport and body exception messages", () =>
    Effect.gen(function* () {
      for (const body of [false, true]) {
        using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
          if (!body) throw new Error("failed synthetic-token");
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("failed synthetic-token"));
              },
            }),
          );
        });
        const error = yield* (yield* httpTransport("http://127.0.0.1:7341"))
          .request({ method: "GET", path: "/media", token: "synthetic-token" })
          .pipe(Effect.catch((error) => Effect.succeed(error)));
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain("synthetic-token");
        expect((error as Error).message).toContain("***");
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
