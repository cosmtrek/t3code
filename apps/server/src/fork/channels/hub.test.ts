// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Exercises the plain-TypeScript hub with temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  ChannelConfigError,
  createTokenReader,
  validateLoopbackBaseUrl,
  type ChannelConfigEntry,
} from "./config.ts";
import { ChannelHub, channelAccess, type ChannelStatus } from "./hub.ts";
import { Conversation, createSseParser, page, parseChannelEvent } from "./protocol.ts";
import {
  AdapterUnreachableError,
  type AdapterRequest,
  type AdapterResponse,
  type ChannelTransport,
} from "./transport.ts";

const encoder = new TextEncoder();
const json = (status: number, value: unknown): AdapterResponse => ({
  status,
  contentType: "application/json",
  body: encoder.encode(JSON.stringify(value)),
});

const HEALTH = {
  protocol: 1,
  adapterVersion: "1.2.3",
  online: true,
  loggedIn: true,
  lastSyncAt: "2026-11-14T08:00:00.000Z",
  self: { id: "u1", name: "Me" },
};
const CONFIG = {
  displayName: "Chat",
  defaultProjectPaths: [],
  delegateTemplates: [{ id: "t", name: "T", prompt: "{contextDir}" }],
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
) {
  const dir = await tempDir();
  const tokenFile = NodePath.join(dir, "token");
  await NodeFSP.writeFile(tokenFile, "secret-token\n", { mode: 0o600 });
  const hub = new ChannelHub({
    configPath: NodePath.join(dir, "channels.json"),
    transportFor: () => fakeTransport(handle),
    background: false,
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
        throw new AdapterUnreachableError("connect ECONNREFUSED");
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
      name: "newer protocol",
      handle: () => json(200, { ...HEALTH, protocol: 2 }),
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
    hub.stop();
  });

  it("serves the last answer while the adapter is unreachable", async () => {
    let up = true;
    const { hub } = await hubWith((request) => {
      if (!up) throw new AdapterUnreachableError("down");
      if (request.path === "/health") return json(200, HEALTH);
      if (request.path === "/config") return json(200, CONFIG);
      return json(200, { items: [], nextCursor: null });
    });
    await hub.test("chat");
    const schema = page(Conversation);
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
    hub.stop();
  });

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
    hub.stop();
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
});

describe("token reader", () => {
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
    parse('"topicId":"t","messageId":"m"}\n\n: ping\n\nevent: health.changed\ndata: {}\n\n');
    expect(frames.map(([event, data]) => parseChannelEvent(event, data))).toEqual([
      { type: "message.created", conversationId: "c", topicId: "t", messageId: "m" },
      { type: "health.changed" },
    ]);
    expect(parseChannelEvent("message.created", "{bad")).toBeNull();
    expect(parseChannelEvent("other", "{}")).toBeNull();
  });
});
