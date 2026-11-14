// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off extendsNativeError:off - Runs outside the Effect runtime: adapter sockets, timers, and plain callbacks.
import * as Schema from "effect/Schema";

import {
  type ChannelConfigEntry,
  type ChannelsFile,
  createTokenReader,
  readChannelsFile,
  validateChannelEntry,
  writeChannelsFile,
  ChannelConfigError,
} from "./config.ts";
import { createExampleChannel, type ExampleChannel } from "./example/exampleChannel.ts";
import {
  AdapterConfig,
  ChannelHealth,
  CHANNEL_PROTOCOL_VERSION,
  ProtocolProbe,
  type ChannelEvent,
} from "./protocol.ts";
import {
  AdapterUnreachableError,
  httpTransport,
  type AdapterResponse,
  type ChannelTransport,
} from "./transport.ts";

export type ChannelStatus =
  | "disabled"
  | "token_missing"
  | "unreachable"
  | "unauthorized"
  | "incompatible"
  | "needs_login"
  | "collector_stopped"
  | "online";

export type ChannelCheckStepId = "token" | "connect" | "auth" | "protocol" | "login" | "online";

export interface ChannelCheckStep {
  readonly id: ChannelCheckStepId;
  readonly ok: boolean;
  readonly detail: string;
}

/** What the inbox may do with a channel in each status (see the status table in FORK.md). */
export function channelAccess(status: ChannelStatus): {
  readonly read: boolean;
  readonly send: boolean;
  readonly stale: boolean;
} {
  switch (status) {
    case "online":
    case "collector_stopped":
      return { read: true, send: true, stale: false };
    case "needs_login":
      return { read: true, send: false, stale: false };
    case "unreachable":
      return { read: true, send: false, stale: true };
    default:
      return { read: false, send: false, stale: false };
  }
}

export interface ChannelView {
  readonly id: string;
  readonly kind: ChannelConfigEntry["kind"];
  readonly name: string;
  readonly baseUrl: string;
  readonly tokenFile: string;
  readonly enabled: boolean;
  readonly status: ChannelStatus;
  readonly statusSince: string;
  readonly lastCheckedAt: string | null;
  readonly steps: ReadonlyArray<ChannelCheckStep>;
  readonly tokenWarning: string | null;
  readonly health: ChannelHealth | null;
  readonly config: AdapterConfig | null;
}

export type HubEvent =
  | { readonly type: "channels" }
  | {
      readonly type: "inbox";
      readonly channelId: string;
      readonly conversationId?: string;
      readonly topicId?: string;
    };

export class ChannelUnavailableError extends Error {
  readonly channelId: string;
  readonly status: ChannelStatus | "missing";
  constructor(channelId: string, status: ChannelStatus | "missing", message: string) {
    super(message);
    this.channelId = channelId;
    this.status = status;
  }
}

export class AdapterRequestError extends Error {
  readonly httpStatus: number;
  readonly code: string;
  constructor(httpStatus: number, code: string, message: string) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

interface Runtime {
  entry: ChannelConfigEntry;
  transport: ChannelTransport;
  status: ChannelStatus;
  statusSince: string;
  lastCheckedAt: string | null;
  steps: ReadonlyArray<ChannelCheckStep>;
  token: string | null;
  tokenWarning: string | null;
  health: ChannelHealth | null;
  config: AdapterConfig | null;
  cache: Map<string, { readonly at: number; readonly value: unknown }>;
  lastGood: Map<string, unknown>;
  stop: AbortController;
  checking: Promise<void> | null;
}

const CHECK_INTERVAL_MS = 30_000;
const EVENT_RETRY_MIN_MS = 5_000;
const EVENT_RETRY_MAX_MS = 60_000;
/** Lists change on every adapter event, which invalidates them; this only bounds a missed one. */
const LIST_CACHE_MS = 20_000;
const LAST_GOOD_LIMIT = 500;

const decodeHealth = Schema.decodeUnknownExit(ChannelHealth);
const decodeProbe = Schema.decodeUnknownExit(ProtocolProbe);
const decodeConfig = Schema.decodeUnknownExit(AdapterConfig);
const decodeAdapterError = Schema.decodeUnknownOption(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);

const textDecoder = new TextDecoder();

function parseJson(response: AdapterResponse): unknown {
  try {
    return JSON.parse(textDecoder.decode(response.body));
  } catch {
    return undefined;
  }
}

function adapterError(response: AdapterResponse): AdapterRequestError {
  const parsed = decodeAdapterError(parseJson(response));
  return parsed._tag === "Some"
    ? new AdapterRequestError(response.status, parsed.value.error.code, parsed.value.error.message)
    : new AdapterRequestError(
        response.status,
        "unknown",
        `The adapter answered HTTP ${response.status}.`,
      );
}

export interface ChannelHubOptions {
  readonly configPath: string;
  readonly now?: () => number;
  /** Tests pass their own transports; the default is loopback HTTP and the in-process example. */
  readonly transportFor?: (entry: ChannelConfigEntry) => ChannelTransport;
  /** Tests run checks by hand. */
  readonly background?: boolean;
}

export class ChannelHub {
  private file: ChannelsFile | null = null;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly listeners = new Set<(event: HubEvent) => void>();
  private readonly readToken = createTokenReader();
  private example: ExampleChannel | null = null;
  private readonly now: () => number;
  private writes: Promise<unknown> = Promise.resolve();

  private readonly options: ChannelHubOptions;

  constructor(options: ChannelHubOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.file = await readChannelsFile(this.options.configPath);
    for (const entry of this.file.channels) this.startRuntime(entry);
  }

  stop(): void {
    for (const runtime of this.runtimes.values()) runtime.stop.abort();
    this.runtimes.clear();
    this.example?.dispose();
    this.example = null;
    this.listeners.clear();
  }

  subscribe(listener: (event: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): ReadonlyArray<ChannelView> {
    return (this.file?.channels ?? []).flatMap((entry) => {
      const runtime = this.runtimes.get(entry.id);
      return runtime ? [this.view(runtime)] : [];
    });
  }

  get(channelId: string): ChannelView | null {
    const runtime = this.runtimes.get(channelId);
    return runtime ? this.view(runtime) : null;
  }

  /** Adds or replaces one channel. `previousId` renames are refused: ids are stable. */
  async save(
    input: ChannelConfigEntry,
    options: { readonly create: boolean },
  ): Promise<ChannelView> {
    const entry = validateChannelEntry(input);
    return this.serialize(async () => {
      const file = this.file ?? (await readChannelsFile(this.options.configPath));
      const existing = file.channels.find((candidate) => candidate.id === entry.id);
      if (options.create && existing) {
        throw new ChannelConfigError(`A channel with the id "${entry.id}" already exists.`, "id");
      }
      if (!options.create && !existing) {
        throw new ChannelConfigError(`No channel has the id "${entry.id}".`, "id");
      }
      if (existing && existing.kind !== entry.kind) {
        throw new ChannelConfigError("A channel's kind cannot change.", "id");
      }
      const channels = existing
        ? file.channels.map((candidate) => (candidate.id === entry.id ? entry : candidate))
        : [...file.channels, entry];
      const next: ChannelsFile = { version: 1, channels };
      await writeChannelsFile(this.options.configPath, next);
      this.file = next;
      this.runtimes.get(entry.id)?.stop.abort();
      this.runtimes.delete(entry.id);
      const runtime = this.startRuntime(entry);
      this.publish({ type: "channels" });
      this.publish({ type: "inbox", channelId: entry.id });
      if (entry.enabled) await this.runCheck(runtime);
      return this.view(runtime);
    });
  }

  async remove(channelId: string): Promise<boolean> {
    return this.serialize(async () => {
      const file = this.file ?? (await readChannelsFile(this.options.configPath));
      if (!file.channels.some((entry) => entry.id === channelId)) return false;
      const next: ChannelsFile = {
        version: 1,
        channels: file.channels.filter((entry) => entry.id !== channelId),
      };
      await writeChannelsFile(this.options.configPath, next);
      this.file = next;
      this.runtimes.get(channelId)?.stop.abort();
      this.runtimes.delete(channelId);
      this.publish({ type: "channels" });
      this.publish({ type: "inbox", channelId });
      return true;
    });
  }

  /** Runs every step now and returns the channel as it stands afterwards. */
  async test(channelId: string): Promise<ChannelView> {
    const runtime = this.requireRuntime(channelId);
    await this.runCheck(runtime, { force: true });
    return this.view(runtime);
  }

  /** A JSON GET through the channel. While the adapter is unreachable, the last answer is served. */
  async getJson<A>(
    channelId: string,
    path: string,
    schema: Schema.Decoder<A>,
    options: { readonly cacheMs?: number } = {},
  ): Promise<{ readonly value: A; readonly stale: boolean }> {
    const runtime = this.requireRuntime(channelId);
    const access = channelAccess(runtime.status);
    if (!access.read) {
      throw new ChannelUnavailableError(
        channelId,
        runtime.status,
        this.unavailableMessage(runtime),
      );
    }
    const cacheMs = options.cacheMs ?? LIST_CACHE_MS;
    const cached = runtime.cache.get(path);
    if (cached && this.now() - cached.at < cacheMs) {
      return { value: cached.value as A, stale: false };
    }
    if (access.stale) return this.lastGood<A>(runtime, path);
    let response: AdapterResponse;
    try {
      response = await runtime.transport.request({ method: "GET", path, token: runtime.token });
    } catch (error) {
      if (error instanceof AdapterUnreachableError) {
        void this.runCheck(runtime);
        return this.lastGood<A>(runtime, path);
      }
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      void this.runCheck(runtime);
      throw new ChannelUnavailableError(
        channelId,
        "unauthorized",
        "The adapter refused the token.",
      );
    }
    if (response.status >= 400) throw adapterError(response);
    const decoded = Schema.decodeUnknownExit(schema)(parseJson(response));
    if (decoded._tag === "Failure") {
      throw new AdapterRequestError(
        502,
        "invalid_response",
        `The adapter's answer to ${path.split("?")[0]} does not match protocol ${CHANNEL_PROTOCOL_VERSION}.`,
      );
    }
    const value = decoded.value;
    runtime.cache.set(path, { at: this.now(), value });
    runtime.lastGood.delete(path);
    runtime.lastGood.set(path, value);
    if (runtime.lastGood.size > LAST_GOOD_LIMIT) {
      const oldest = runtime.lastGood.keys().next().value;
      if (oldest !== undefined) runtime.lastGood.delete(oldest);
    }
    return { value, stale: false };
  }

  async getMedia(channelId: string, path: string): Promise<AdapterResponse> {
    const runtime = this.requireRuntime(channelId);
    if (!channelAccess(runtime.status).read || runtime.status === "unreachable") {
      throw new ChannelUnavailableError(
        channelId,
        runtime.status,
        this.unavailableMessage(runtime),
      );
    }
    const response = await runtime.transport.request({ method: "GET", path, token: runtime.token });
    if (response.status >= 400) throw adapterError(response);
    return response;
  }

  async postJson(channelId: string, path: string, body: unknown): Promise<unknown> {
    const runtime = this.requireRuntime(channelId);
    if (!channelAccess(runtime.status).send) {
      throw new ChannelUnavailableError(
        channelId,
        runtime.status,
        this.unavailableMessage(runtime),
      );
    }
    let response: AdapterResponse;
    try {
      response = await runtime.transport.request({
        method: "POST",
        path,
        body,
        token: runtime.token,
      });
    } catch (error) {
      if (error instanceof AdapterUnreachableError) {
        void this.runCheck(runtime);
        throw new ChannelUnavailableError(
          channelId,
          "unreachable",
          "The adapter cannot be reached.",
        );
      }
      throw error;
    }
    if (response.status >= 400) throw adapterError(response);
    return parseJson(response);
  }

  /** Drops cached lists so the next read asks the adapter. */
  invalidate(channelId: string): void {
    this.runtimes.get(channelId)?.cache.clear();
  }

  private lastGood<T>(runtime: Runtime, path: string): { value: T; stale: boolean } {
    if (!runtime.lastGood.has(path)) {
      throw new ChannelUnavailableError(
        runtime.entry.id,
        "unreachable",
        "The adapter cannot be reached and nothing was read from it yet.",
      );
    }
    return { value: runtime.lastGood.get(path) as T, stale: true };
  }

  private unavailableMessage(runtime: Runtime): string {
    switch (runtime.status) {
      case "disabled":
        return "This channel is turned off.";
      case "token_missing":
        return runtime.steps.find((step) => !step.ok)?.detail ?? "The token file cannot be read.";
      case "unauthorized":
        return "The adapter refused the token.";
      case "incompatible":
        return "The adapter speaks a protocol this version of T3 Code does not.";
      case "needs_login":
        return "The adapter needs you to sign in before it can send.";
      case "unreachable":
        return "The adapter cannot be reached.";
      default:
        return "The channel is not available.";
    }
  }

  private requireRuntime(channelId: string): Runtime {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) throw new ChannelUnavailableError(channelId, "missing", "No such channel.");
    return runtime;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writes.then(task, task);
    this.writes = result.catch(() => undefined);
    return result;
  }

  publish(event: HubEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure must not stop the others.
      }
    }
  }

  private transportFor(entry: ChannelConfigEntry): ChannelTransport {
    if (this.options.transportFor) return this.options.transportFor(entry);
    if (entry.kind === "example") {
      this.example ??= createExampleChannel({ now: this.now });
      return this.example;
    }
    return httpTransport(entry.baseUrl);
  }

  private startRuntime(entry: ChannelConfigEntry): Runtime {
    const runtime: Runtime = {
      entry,
      transport: this.transportFor(entry),
      status: entry.enabled ? "unreachable" : "disabled",
      statusSince: new Date(this.now()).toISOString(),
      lastCheckedAt: null,
      steps: [],
      token: null,
      tokenWarning: null,
      health: null,
      config: null,
      cache: new Map(),
      lastGood: new Map(),
      stop: new AbortController(),
      checking: null,
    };
    this.runtimes.set(entry.id, runtime);
    if (entry.enabled && this.options.background !== false) {
      void this.runCheck(runtime);
      const interval = setInterval(() => void this.runCheck(runtime), CHECK_INTERVAL_MS);
      interval.unref?.();
      runtime.stop.signal.addEventListener("abort", () => clearInterval(interval));
      void this.followEvents(runtime);
    }
    return runtime;
  }

  private async followEvents(runtime: Runtime) {
    let delay = EVENT_RETRY_MIN_MS;
    const signal = runtime.stop.signal;
    while (!signal.aborted) {
      if (runtime.checking) await runtime.checking;
      if (channelAccess(runtime.status).read && runtime.status !== "unreachable") {
        try {
          await runtime.transport.events(
            runtime.token,
            (event) => this.onEvent(runtime, event),
            signal,
          );
          delay = EVENT_RETRY_MIN_MS;
        } catch {
          void this.runCheck(runtime);
        }
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      delay = Math.min(delay * 2, EVENT_RETRY_MAX_MS);
    }
  }

  private onEvent(runtime: Runtime, event: ChannelEvent) {
    if (event.type === "health.changed") {
      void this.runCheck(runtime);
      return;
    }
    runtime.cache.clear();
    this.publish({
      type: "inbox",
      channelId: runtime.entry.id,
      conversationId: event.conversationId,
      topicId: event.topicId,
    });
  }

  /** One check at a time per channel; a forced check waits for the running one and runs again. */
  private async runCheck(runtime: Runtime, options: { readonly force?: boolean } = {}) {
    if (runtime.checking) {
      await runtime.checking;
      if (!options.force) return;
    }
    runtime.checking = this.check(runtime).finally(() => {
      runtime.checking = null;
    });
    await runtime.checking;
  }

  private async check(runtime: Runtime) {
    const before = JSON.stringify([runtime.status, runtime.steps, runtime.health, runtime.config]);
    const result = await this.evaluate(runtime);
    runtime.lastCheckedAt = new Date(this.now()).toISOString();
    if (result.status !== runtime.status) {
      runtime.statusSince = runtime.lastCheckedAt;
      runtime.status = result.status;
      runtime.cache.clear();
    }
    runtime.steps = result.steps;
    if (result.health) runtime.health = result.health;
    if (result.config) runtime.config = result.config;
    const after = JSON.stringify([runtime.status, runtime.steps, runtime.health, runtime.config]);
    if (before !== after) {
      this.publish({ type: "channels" });
      this.publish({ type: "inbox", channelId: runtime.entry.id });
    }
  }

  private async evaluate(runtime: Runtime): Promise<{
    status: ChannelStatus;
    steps: ChannelCheckStep[];
    health?: ChannelHealth;
    config?: AdapterConfig;
  }> {
    const steps: ChannelCheckStep[] = [];
    const fail = (status: ChannelStatus, id: ChannelCheckStepId, detail: string) => {
      steps.push({ id, ok: false, detail });
      return { status, steps };
    };
    if (!runtime.entry.enabled) return { status: "disabled", steps };
    if (runtime.entry.kind === "example") {
      runtime.token = null;
      runtime.tokenWarning = null;
      steps.push({ id: "token", ok: true, detail: "The example channel needs no token." });
    } else {
      const token = await this.readToken(runtime.entry.tokenFile);
      if (!token.ok) {
        runtime.token = null;
        return fail("token_missing", "token", token.reason);
      }
      runtime.token = token.token;
      runtime.tokenWarning = token.warning;
      steps.push({ id: "token", ok: true, detail: token.warning ?? "Read the token." });
    }
    const started = this.now();
    let response: AdapterResponse;
    try {
      response = await runtime.transport.request({
        method: "GET",
        path: "/health",
        token: runtime.token,
      });
    } catch (error) {
      return fail(
        "unreachable",
        "connect",
        `${runtime.entry.baseUrl || "The adapter"} cannot be reached: ${(error as Error).message}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      steps.push({ id: "connect", ok: true, detail: `Answered in ${this.now() - started} ms.` });
      return fail(
        "unauthorized",
        "auth",
        `The adapter refused the token (HTTP ${response.status}).`,
      );
    }
    if (response.status >= 400) {
      return fail("unreachable", "connect", `The adapter answered HTTP ${response.status}.`);
    }
    steps.push({ id: "connect", ok: true, detail: `Answered in ${this.now() - started} ms.` });
    steps.push({ id: "auth", ok: true, detail: "The adapter accepted the token." });
    const body = parseJson(response);
    const probe = decodeProbe(body);
    if (probe._tag === "Failure") {
      return fail(
        "incompatible",
        "protocol",
        "The adapter's /health answer has no protocol version.",
      );
    }
    if (Math.trunc(probe.value.protocol) !== CHANNEL_PROTOCOL_VERSION) {
      return fail(
        "incompatible",
        "protocol",
        `The adapter speaks protocol ${probe.value.protocol}; T3 Code speaks protocol ${CHANNEL_PROTOCOL_VERSION}.`,
      );
    }
    const health = decodeHealth(body);
    if (health._tag === "Failure") {
      return fail(
        "incompatible",
        "protocol",
        `The adapter's /health answer does not match protocol ${CHANNEL_PROTOCOL_VERSION}.`,
      );
    }
    let config: AdapterConfig | undefined;
    try {
      const configResponse = await runtime.transport.request({
        method: "GET",
        path: "/config",
        token: runtime.token,
      });
      const decoded = decodeConfig(parseJson(configResponse));
      if (configResponse.status < 400 && decoded._tag === "Success") config = decoded.value;
    } catch {
      // /health answered a moment ago; a failed /config keeps the previous one.
    }
    if (config === undefined && runtime.config === null) {
      return {
        ...fail(
          "incompatible",
          "protocol",
          `The adapter's /config answer does not match protocol ${CHANNEL_PROTOCOL_VERSION}.`,
        ),
        health: health.value,
      };
    }
    steps.push({
      id: "protocol",
      ok: true,
      detail: `Protocol ${CHANNEL_PROTOCOL_VERSION}, adapter ${health.value.adapterVersion}.`,
    });
    const extra = { health: health.value, ...(config ? { config } : {}) };
    if (!health.value.loggedIn) {
      return {
        ...fail(
          "needs_login",
          "login",
          health.value.lastError ?? "The adapter is not signed in. Sign in through the adapter.",
        ),
        ...extra,
      };
    }
    steps.push({ id: "login", ok: true, detail: `Signed in as ${health.value.self.name}.` });
    if (!health.value.online) {
      return {
        ...fail(
          "collector_stopped",
          "online",
          health.value.lastError ?? "The adapter's collector is not running.",
        ),
        ...extra,
      };
    }
    steps.push({ id: "online", ok: true, detail: "The collector is running." });
    return { status: "online", steps, ...extra };
  }

  private view(runtime: Runtime): ChannelView {
    const { entry } = runtime;
    return {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      baseUrl: entry.baseUrl,
      tokenFile: entry.tokenFile,
      enabled: entry.enabled,
      status: runtime.status,
      statusSince: runtime.statusSince,
      lastCheckedAt: runtime.lastCheckedAt,
      steps: runtime.steps,
      tokenWarning: runtime.tokenWarning,
      health: runtime.health,
      config: runtime.config,
    };
  }
}
