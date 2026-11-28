// @effect-diagnostics nodeBuiltinImport:off - Independent channel configuration and token fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import { ChannelHub, type HubEvent } from "./hub.ts";
import { RawPage } from "./protocol.ts";
import { httpTransport, type AdapterResponse, type ChannelTransport } from "./transport.ts";

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

async function fixture(transport: ChannelTransport, background = false, example = false) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "channel-lifecycle-"));
  const entry = {
    id: "chat",
    name: "Chat",
    kind: example ? ("example" as const) : ("http-adapter" as const),
    enabled: true,
    baseUrl: "http://127.0.0.1:7341",
    tokenFile: NodePath.join(dir, "token"),
  };
  await NodeFSP.writeFile(entry.tokenFile, "synthetic-token", { mode: 0o600 });
  await NodeFSP.writeFile(
    NodePath.join(dir, "channels.json"),
    JSON.stringify({ version: 1, channels: [entry] }),
  );
  const hub = new ChannelHub({
    configPath: NodePath.join(dir, "channels.json"),
    transportFor: () => transport,
    background,
  });
  await hub.start();
  return {
    hub,
    entry,
    async [Symbol.asyncDispose]() {
      hub.stop();
      await NodeFSP.rm(dir, { recursive: true, force: true });
    },
  };
}

const changes = ["stop", "remove", "replace"] as const;
async function change(h: Awaited<ReturnType<typeof fixture>>, operation: (typeof changes)[number]) {
  if (operation === "stop") h.hub.stop();
  else if (operation === "remove") await h.hub.remove("chat");
  else await h.hub.save({ ...h.entry, enabled: false }, { create: false });
}

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
    for (const force of [false, true]) {
      // Known defect: stopping the channel does not cancel its health request or queued forced check.
      it.fails(`${operation} cancels a health request${force ? " and a forced check waiting behind it" : ""}`, async () => {
        const entered = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<AdapterResponse>();
        let requests = 0;
        const transport = eventTransport();
        await using h = await fixture({
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
        const checking = h.hub.test("chat");
        await entered.promise;
        const forced = force ? h.hub.test("chat") : Promise.resolve();
        await change(h, operation);
        const count = requests;
        h.hub.subscribe((event) => published.push(event));
        answer.resolve(json(health));
        await Promise.allSettled([checking, forced]);
        expect(published).toEqual([]);
        expect(requests).toBe(count);
      });
    }
    it(`${operation} closes the SSE connection and prevents reconnecting`, async () => {
      vi.useFakeTimers();
      try {
        const connected = Promise.withResolvers<void>();
        const cancelled = Promise.withResolvers<void>();
        let connections = 0;
        await using h = await fixture(
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
        await connected.promise;
        await change(h, operation);
        await cancelled.promise;
        const revision = h.hub.revision("chat");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(connections).toBe(1);
        expect(h.hub.revision("chat")).toBe(revision);
      } finally {
        vi.useRealTimers();
      }
    });
    it(`${operation} cancels the event retry and scheduled health check`, async () => {
      vi.useFakeTimers();
      try {
        const ended = Promise.withResolvers<void>();
        let connections = 0;
        let requests = 0;
        await using h = await fixture(
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
        await ended.promise;
        await vi.advanceTimersByTimeAsync(0);
        await change(h, operation);
        const count = requests;
        const revision = h.hub.revision("chat");
        await vi.advanceTimersByTimeAsync(120_000);
        expect(connections).toBe(1);
        expect(requests).toBe(count);
        expect(h.hub.revision("chat")).toBe(revision);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("channel cache and scheduling", () => {
  it("expires cached lists at 20 seconds and shares a read after one reader cancels", async () => {
    vi.useFakeTimers();
    try {
      const entered = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<AdapterResponse>();
      let reads = 0;
      await using h = await fixture({
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
      await h.hub.test("chat");
      expect(await h.hub.getJson("chat", "/conversations", RawPage)).toEqual({
        value: page,
        stale: false,
      });
      await vi.advanceTimersByTimeAsync(19_999);
      await h.hub.getJson("chat", "/conversations", RawPage);
      expect(reads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Exercise cancellation at the existing Promise consumer boundary.
      const reader = Effect.runFork(
        Effect.promise(() => h.hub.getJson("chat", "/conversations", RawPage)),
      );
      await entered.promise;
      const other = h.hub.getJson("chat", "/conversations", RawPage);
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Interrupt the Promise reader without cancelling the shared request.
      await Effect.runPromise(Fiber.interrupt(reader));
      answer.resolve(json(page));
      expect(await other).toEqual({ value: page, stale: false });
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doubles event retry to 60 seconds and resets after a clean connection closes", async () => {
    vi.useFakeTimers();
    try {
      const first = Promise.withResolvers<void>();
      let connections = 0;
      let healthy = false;
      await using _h = await fixture(
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
      await first.promise;
      await vi.advanceTimersByTimeAsync(0);
      for (const delay of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
        const count = connections;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(connections).toBe(count);
        await vi.advanceTimersByTimeAsync(1);
        expect(connections).toBe(count + 1);
      }
      healthy = true;
      await vi.advanceTimersByTimeAsync(60_000);
      const count = connections;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(connections).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(connections).toBe(count + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off health checks to 30 seconds and resets after recovery", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      let checks = 0;
      await using h = await fixture(
        {
          ...eventTransport(),
          request: async ({ path }) => {
            if (path === "/health") {
              checks++;
              if (!up) throw new Error("offline");
              return json(health);
            }
            return json(config);
          },
        },
        true,
        true,
      );
      await h.hub.test("chat");
      // A forced check has already consumed the first 5-second backoff.
      for (const delay of [10_000, 20_000, 30_000]) {
        const count = checks;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(checks).toBe(count);
        await vi.advanceTimersByTimeAsync(1);
        expect(checks).toBe(count + 1);
      }
      up = true;
      await h.hub.test("chat");
      up = false;
      await h.hub.test("chat");
      const count = checks;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(checks).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(checks).toBe(count + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HTTP transport boundaries", () => {
  it.each([false, true])("times out requests and response bodies (media=%s)", async (media) => {
    vi.useFakeTimers();
    using _timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      // @effect-diagnostics-next-line globalTimers:off - Make the existing AbortSignal timeout deterministic before Effect migration.
      setTimeout(
        () =>
          controller.abort(
            new DOMException("The operation was aborted due to timeout", "TimeoutError"),
          ),
        ms,
      );
      return controller.signal;
    });
    try {
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
        const pending = httpTransport("http://127.0.0.1:7341")
          .request({ method: "GET", path: "/media", token: null, media })
          .then(
            () => null,
            (error: unknown) => error,
          );
        await entered.promise;
        await vi.advanceTimersByTimeAsync((media ? 120_000 : 10_000) - 1);
        expect(aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBeInstanceOf(Error);
        expect(aborted).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("enforces declared and actual byte limits (media=%s)", async (media) => {
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
    const transport = httpTransport("http://127.0.0.1:7341");
    await expect(
      transport.request({ method: "GET", path: "/media", token: null, media }),
    ).rejects.toThrow(`The adapter answered with ${size + 1} bytes, more than allowed.`);
    expect(cancelled).toBe(true);
    _fetch.mockResolvedValue(new Response(new Uint8Array(size + 1)));
    await expect(
      transport.request({ method: "GET", path: "/media", token: null, media }),
    ).rejects.toThrow("The adapter's answer is larger than allowed.");
  });

  it("rejects redirects and never retries a POST", async () => {
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    });
    await expect(
      httpTransport("http://localhost:7341").request({
        method: "POST",
        path: "/messages",
        body: { text: "once" },
        token: "synthetic-token",
      }),
    ).rejects.toThrow("unexpected redirect");
    expect(_fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])(
    "preserves HTTP %s and rejects an unauthorized event stream",
    async (status) => {
      using _fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response("not json", { status }));
      const transport = httpTransport("http://127.0.0.1:7341");
      const response = await transport.request({ method: "GET", path: "/health", token: null });
      expect(response.status).toBe(status);
      expect(new TextDecoder().decode(response.body)).toBe("not json");
      const events: unknown[] = [];
      await expect(
        transport.events(null, (event) => events.push(event), new AbortController().signal),
      ).rejects.toThrow(`The adapter's event stream answered ${status}.`);
      expect(events).toEqual([]);
    },
  );

  it("decodes split UTF-8 and SSE frames then reports a stream interruption", async () => {
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
    const pending = httpTransport("http://127.0.0.1:7341")
      .events(
        null,
        (event) => {
          events.push(event);
          if (event.type === "connected") connected.resolve();
          else delivered.resolve();
        },
        new AbortController().signal,
      )
      .catch((error: unknown) => error);
    await connected.promise;
    const bytes = new TextEncoder().encode(
      'event: message.created\ndata: {"conversationId":"中文"}\n\n',
    );
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    await delivered.promise;
    controller.error(new Error("stream interrupted"));
    expect(await pending).toEqual(new Error("stream interrupted"));
    expect(events).toEqual([
      { type: "connected" },
      { type: "message.created", conversationId: "中文" },
    ]);
  });

  // Known defect authorized in batch3-r2: transport/body exceptions expose an echoed token.
  it.fails("redacts tokens from transport and body exception messages", async () => {
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
      const error = await httpTransport("http://127.0.0.1:7341")
        .request({ method: "GET", path: "/media", token: "synthetic-token" })
        .catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("synthetic-token");
      expect((error as Error).message).toContain("***");
    }
  });
});
