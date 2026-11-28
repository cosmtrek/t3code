// @effect-diagnostics globalDate:off globalTimers:off extendsNativeError:off - Runs outside the Effect runtime: adapter sockets, timers, and plain callbacks.
import * as Schema from "effect/Schema";

import {
  type ChannelConfigEntry,
  type ChannelsFile,
  channelIdFor,
  createTokenReader,
  readChannelsFile,
  validateAdapterAddress,
  validateChannelEntry,
  writeChannelsFile,
  ChannelConfigError,
} from "./config.ts";
import {
  createExampleChannel,
  type ExampleChannel,
  type ExampleSimulation,
} from "./example/exampleChannel.ts";
import {
  AdapterConfig,
  ChannelHealth,
  CHANNEL_PROTOCOL_VERSION,
  ProtocolProbe,
  RawPage,
  type ChannelEvent,
} from "./protocol.ts";
import {
  AdapterUnreachableError,
  httpTransport,
  type AdapterResponse,
  type ChannelTransport,
  type AdapterRequest,
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
  /** The example channel's simulated state; null for adapters. */
  readonly simulation: ExampleSimulation | null;
}

/** A check of an adapter that is not saved yet, so a channel is added only once it answers. */
export type ChannelProbe = Pick<
  ChannelView,
  "status" | "steps" | "tokenWarning" | "health" | "config"
>;

/** What reaches the browser: which local channel changed, never an adapter's own ids. */
export type HubEvent =
  | { readonly type: "channels" }
  | { readonly type: "inbox"; readonly channelId: string }
  /** Only `lastSyncAt` or the latency moved: nothing a list shows, just "synced x ago". */
  | { readonly type: "sync"; readonly channelId: string }
  /** A listing the overview stopped waiting for has landed: its counts can be read now. */
  | { readonly type: "counts"; readonly channelId: string };

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
  /** Reads under way, so concurrent views of one path share one adapter request. */
  inflight: Map<string, Promise<{ readonly value: unknown; readonly stale: boolean }>>;
  /** Bumped on every invalidation; a read that started before one does not fill the cache. */
  generation: number;
  lastGood: Map<string, unknown>;
  stop: AbortController;
  checking: Promise<void> | null;
  nextCheck: ReturnType<typeof setTimeout> | null;
  retryMs: number | null;
}

const CHECK_INTERVAL_MS = 30_000;
const UNREACHABLE_RETRY_MIN_MS = 5_000;

/**
 * When to check a channel next. An unreachable adapter is usually one being restarted, so it is
 * retried after 5 seconds, doubling up to the usual interval; `retryMs` carries that backoff.
 */
export function nextCheckDelay(
  status: ChannelStatus,
  retryMs: number | null,
): { readonly delayMs: number; readonly retryMs: number | null } {
  if (status !== "unreachable") return { delayMs: CHECK_INTERVAL_MS, retryMs: null };
  const delayMs = retryMs ?? UNREACHABLE_RETRY_MIN_MS;
  return { delayMs, retryMs: Math.min(delayMs * 2, CHECK_INTERVAL_MS) };
}
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

/**
 * An adapter may echo the token back in an error, `/health`, or `/config`. Everything read from
 * it passes through here before it can reach a browser.
 */
function redactToken<T>(value: T, token: string | null): T {
  if (token === null || token.length === 0) return value;
  const scrub = (current: unknown): unknown => {
    if (typeof current === "string") {
      return current.includes(token) ? current.split(token).join("***") : current;
    }
    if (Array.isArray(current)) return current.map(scrub);
    if (typeof current === "object" && current !== null) {
      return Object.fromEntries(
        Object.entries(current).map(([key, entry]) => [key, scrub(entry)] as const),
      );
    }
    return current;
  };
  return scrub(value) as T;
}

function adapterError(response: AdapterResponse, token: string | null): AdapterRequestError {
  const parsed = decodeAdapterError(parseJson(response));
  return parsed._tag === "Some"
    ? new AdapterRequestError(
        response.status,
        redactToken(parsed.value.error.code, token),
        redactToken(parsed.value.error.message, token),
      )
    : new AdapterRequestError(
        response.status,
        "unknown",
        `The adapter answered HTTP ${response.status}.`,
      );
}

/** Resolves after `ms` or on abort, whichever comes first, and leaves no listener behind. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
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
  /** Bumped whenever what a channel's inbox shows may have changed; see `revision`. */
  private readonly revisions = new Map<string, number>();

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

  /**
   * Adds or replaces one channel. Ids are stable: a new channel without one gets one from its
   * name, and an existing one keeps its own.
   */
  async save(
    input: ChannelConfigEntry,
    options: { readonly create: boolean },
  ): Promise<ChannelView> {
    if (options.create && input.kind === "example") {
      throw new ChannelConfigError("The example channel is built in; turn it on instead.");
    }
    return this.serialize(async () => {
      const file = this.file ?? (await readChannelsFile(this.options.configPath));
      const entry = validateChannelEntry(
        options.create && input.id === ""
          ? { ...input, id: channelIdFor(input.name, new Set(file.channels.map((c) => c.id))) }
          : input,
      );
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
      const existing = file.channels.find((entry) => entry.id === channelId);
      if (!existing) return false;
      if (existing.kind === "example") {
        throw new ChannelConfigError("The example channel is built in; turn it off instead.");
      }
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

  /** Runs every step against an adapter without saving it or keeping what it read. */
  async probe(draft: {
    readonly baseUrl: string;
    readonly tokenFile: string;
  }): Promise<ChannelProbe> {
    const address = validateAdapterAddress(draft);
    const runtime = this.newRuntime({
      id: "",
      kind: "http-adapter",
      name: "",
      ...address,
      enabled: true,
    });
    const result = await this.evaluate(runtime);
    return redactToken(
      {
        status: result.status,
        steps: result.steps,
        tokenWarning: runtime.tokenWarning,
        health: result.health ?? null,
        config: result.config ?? null,
      },
      runtime.token,
    );
  }

  /** Switches the example channel to a made-up state, so every status can be seen in a browser. */
  async simulate(channelId: string, simulation: ExampleSimulation): Promise<ChannelView> {
    const runtime = this.requireRuntime(channelId);
    if (runtime.entry.kind !== "example" || this.example === null) {
      throw new ChannelConfigError("Only the example channel can simulate a state.", "id");
    }
    this.example.setSimulation(simulation);
    // Like a real outage: what was read stays readable, only fresh reads are dropped.
    this.dropCached(runtime);
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
    // A path always decodes with the same schema, so a shared read fits every caller.
    const pending = runtime.inflight.get(path);
    if (pending) return pending as Promise<{ readonly value: A; readonly stale: boolean }>;
    const read = this.readJson(runtime, path, schema).finally(() => {
      if (runtime.inflight.get(path) === read) runtime.inflight.delete(path);
    });
    runtime.inflight.set(path, read);
    return read;
  }

  private async readJson<A>(
    runtime: Runtime,
    path: string,
    schema: Schema.Decoder<A>,
  ): Promise<{ readonly value: A; readonly stale: boolean }> {
    const channelId = runtime.entry.id;
    const generation = runtime.generation;
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
    if (response.status >= 400) throw adapterError(response, runtime.token);
    const decoded = Schema.decodeUnknownExit(schema)(parseJson(response));
    if (decoded._tag === "Failure") {
      throw new AdapterRequestError(
        502,
        "invalid_response",
        `The adapter's answer to ${path.split("?")[0]} does not match protocol ${CHANNEL_PROTOCOL_VERSION}.`,
      );
    }
    const value = redactToken(decoded.value, runtime.token);
    if (runtime.generation === generation) runtime.cache.set(path, { at: this.now(), value });
    runtime.lastGood.delete(path);
    runtime.lastGood.set(path, value);
    if (runtime.lastGood.size > LAST_GOOD_LIMIT) {
      const oldest = runtime.lastGood.keys().next().value;
      if (oldest !== undefined) runtime.lastGood.delete(oldest);
    }
    return { value, stale: false };
  }

  /**
   * Every page of a list, following `nextCursor`. Stops after `maxPages` so a looping adapter
   * cannot hang a request; `complete` says whether the list ended. An item that does not decode
   * is left out and counted in `skipped`, so one bad record does not hide the rest.
   */
  async getAllPages<A>(
    channelId: string,
    path: string,
    itemSchema: Schema.Decoder<A>,
    options: { readonly cacheMs?: number; readonly maxPages: number },
  ): Promise<{
    readonly items: ReadonlyArray<A>;
    readonly stale: boolean;
    readonly complete: boolean;
    readonly skipped: number;
  }> {
    const decodeItem = Schema.decodeUnknownExit(itemSchema);
    const items: A[] = [];
    let stale = false;
    let skipped = 0;
    let cursor: string | null = null;
    const seen = new Set<string>();
    const result = (complete: boolean) => ({ items, stale, complete, skipped });
    for (let count = 0; count < options.maxPages; count++) {
      const pagePath: string =
        cursor === null
          ? path
          : `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
      const answer = await this.getJson(channelId, pagePath, RawPage, options);
      for (const raw of answer.value.items) {
        const decoded = decodeItem(raw);
        if (decoded._tag === "Success") items.push(decoded.value);
        else skipped += 1;
      }
      stale ||= answer.stale;
      cursor = answer.value.nextCursor;
      if (cursor === null) return result(true);
      // An adapter that loops would hand back the same pages again.
      if (seen.has(cursor)) break;
      seen.add(cursor);
    }
    return result(false);
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
    const response = await runtime.transport.request({
      method: "GET",
      path,
      token: runtime.token,
      media: true,
    });
    if (response.status >= 400) throw adapterError(response, runtime.token);
    return response;
  }

  postJson(channelId: string, path: string, body: unknown): Promise<unknown> {
    return this.post(channelId, { path, body });
  }

  /** Hands the adapter a file; like media, it may take the adapter a while to pass it on. */
  upload(channelId: string, path: string, bytes: Uint8Array): Promise<unknown> {
    return this.post(channelId, { path, bytes, media: true });
  }

  private async post(
    channelId: string,
    request: Pick<AdapterRequest, "path" | "body" | "bytes" | "media">,
  ): Promise<unknown> {
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
        ...request,
        method: "POST",
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
    if (response.status >= 400) throw adapterError(response, runtime.token);
    return redactToken(parseJson(response), runtime.token);
  }

  /** Drops cached lists so the next read asks the adapter. */
  invalidate(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (runtime) this.dropCached(runtime);
  }

  /** Drops cached answers whose path starts with one of `prefixes`, or all of them. */
  private dropCached(runtime: Runtime, prefixes?: ReadonlyArray<string>) {
    runtime.generation += 1;
    this.bumpRevision(runtime.entry.id);
    runtime.inflight.clear();
    if (prefixes === undefined) {
      runtime.cache.clear();
      return;
    }
    for (const path of runtime.cache.keys()) {
      if (prefixes.some((prefix) => path.startsWith(prefix))) runtime.cache.delete(path);
    }
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

  /**
   * Changes whenever a cached answer is dropped or an inbox or channels event is published, so a
   * result derived from the channel can be reused while it stays the same.
   */
  revision(channelId: string): number {
    return this.revisions.get(channelId) ?? 0;
  }

  private bumpRevision(channelId: string) {
    this.revisions.set(channelId, this.revision(channelId) + 1);
  }

  publish(event: HubEvent): void {
    if (event.type === "inbox") this.bumpRevision(event.channelId);
    else if (event.type === "channels") {
      for (const channelId of this.runtimes.keys()) this.bumpRevision(channelId);
    }
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

  private newRuntime(entry: ChannelConfigEntry): Runtime {
    return {
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
      inflight: new Map(),
      generation: 0,
      lastGood: new Map(),
      stop: new AbortController(),
      checking: null,
      nextCheck: null,
      retryMs: null,
    };
  }

  private startRuntime(entry: ChannelConfigEntry): Runtime {
    const runtime = this.newRuntime(entry);
    this.runtimes.set(entry.id, runtime);
    if (entry.enabled && this.options.background !== false) {
      runtime.stop.signal.addEventListener("abort", () => {
        if (runtime.nextCheck !== null) clearTimeout(runtime.nextCheck);
      });
      void this.runCheck(runtime);
      void this.followEvents(runtime);
    }
    return runtime;
  }

  /** Every check, whatever started it, sets when the next one runs. */
  private scheduleCheck(runtime: Runtime) {
    if (this.options.background === false || runtime.stop.signal.aborted) return;
    if (!runtime.entry.enabled) return;
    if (runtime.nextCheck !== null) clearTimeout(runtime.nextCheck);
    const next = nextCheckDelay(runtime.status, runtime.retryMs);
    runtime.retryMs = next.retryMs;
    runtime.nextCheck = setTimeout(() => void this.runCheck(runtime), next.delayMs);
    runtime.nextCheck.unref?.();
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
      await sleepUnlessAborted(delay, signal);
      delay = Math.min(delay * 2, EVENT_RETRY_MAX_MS);
    }
  }

  /**
   * Any event, or a (re)connected stream, means the lists may have changed. An event that names
   * its conversation only stales the conversation list and that conversation's own lists.
   */
  private onEvent(runtime: Runtime, event: ChannelEvent) {
    if ("conversationId" in event && event.conversationId !== undefined) {
      this.dropCached(runtime, [
        "/conversations?",
        `/conversations/${encodeURIComponent(event.conversationId)}/`,
      ]);
    } else {
      this.dropCached(runtime);
    }
    if (event.type === "health.changed") {
      void this.runCheck(runtime);
      return;
    }
    this.publish({ type: "inbox", channelId: runtime.entry.id });
  }

  /** One check at a time per channel; a forced check waits for the running one and runs again. */
  private async runCheck(runtime: Runtime, options: { readonly force?: boolean } = {}) {
    if (runtime.checking) {
      await runtime.checking;
      if (!options.force) return;
    }
    runtime.checking = this.check(runtime).finally(() => {
      runtime.checking = null;
      this.scheduleCheck(runtime);
    });
    await runtime.checking;
  }

  private async check(runtime: Runtime) {
    // lastSyncAt moves with every message, which the adapter's events already announced, and the
    // connect step carries the latency; neither changes what a list shows.
    const full = () => JSON.stringify([runtime.health, runtime.steps]);
    const material = () =>
      JSON.stringify([
        runtime.status,
        runtime.steps.map((step) => (step.id === "connect" ? { ...step, detail: "" } : step)),
        runtime.health && { ...runtime.health, lastSyncAt: null },
        runtime.config,
      ]);
    const before = material();
    const fullBefore = full();
    const result = await this.evaluate(runtime);
    runtime.lastCheckedAt = new Date(this.now()).toISOString();
    if (result.status !== runtime.status) {
      runtime.statusSince = runtime.lastCheckedAt;
      runtime.status = result.status;
      this.dropCached(runtime);
    }
    runtime.steps = result.steps;
    if (result.health !== undefined) runtime.health = result.health;
    if (result.config) runtime.config = result.config;
    if (before !== material()) {
      this.publish({ type: "channels" });
      this.publish({ type: "inbox", channelId: runtime.entry.id });
    } else if (fullBefore !== full()) {
      this.publish({ type: "sync", channelId: runtime.entry.id });
    }
  }

  private async evaluate(runtime: Runtime): Promise<{
    status: ChannelStatus;
    steps: ChannelCheckStep[];
    /** null drops what the last check read; absent keeps it. */
    health?: ChannelHealth | null;
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
      steps.push({ id: "token", ok: true, detail: "not needed" });
    } else {
      const token = await this.readToken(runtime.entry.tokenFile);
      if (!token.ok) {
        runtime.token = null;
        return fail("token_missing", "token", token.reason);
      }
      runtime.token = token.token;
      runtime.tokenWarning = token.warning;
      steps.push({ id: "token", ok: true, detail: "" });
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
        `${runtime.entry.baseUrl || "The adapter"} cannot be reached: ${redactToken((error as Error).message, runtime.token)}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      steps.push({ id: "connect", ok: true, detail: `${this.now() - started} ms` });
      return fail(
        "unauthorized",
        "auth",
        `The adapter refused the token (HTTP ${response.status}).`,
      );
    }
    if (response.status >= 400) {
      return fail("unreachable", "connect", `The adapter answered HTTP ${response.status}.`);
    }
    steps.push({ id: "connect", ok: true, detail: `${this.now() - started} ms` });
    steps.push({ id: "auth", ok: true, detail: "" });
    const body = parseJson(response);
    const probe = decodeProbe(body);
    // An adapter on another protocol: what an earlier check read from it no longer holds.
    const incompatible = (detail: string) => ({
      ...fail("incompatible", "protocol", detail),
      health: null,
    });
    if (probe._tag === "Failure") {
      return incompatible("The adapter's /health answer has no protocol version.");
    }
    if (Math.trunc(probe.value.protocol) !== CHANNEL_PROTOCOL_VERSION) {
      return incompatible(
        `The adapter speaks protocol ${probe.value.protocol}; T3 Code speaks protocol ${CHANNEL_PROTOCOL_VERSION}.`,
      );
    }
    const health = decodeHealth(redactToken(body, runtime.token));
    if (health._tag === "Failure") {
      return incompatible(
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
      const decoded = decodeConfig(redactToken(parseJson(configResponse), runtime.token));
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
      detail: String(CHANNEL_PROTOCOL_VERSION),
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
    steps.push({ id: "login", ok: true, detail: health.value.self.name });
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
    steps.push({ id: "online", ok: true, detail: "" });
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
      steps: redactToken(runtime.steps, runtime.token),
      tokenWarning: runtime.tokenWarning,
      health: runtime.health,
      config: runtime.config,
      simulation: entry.kind === "example" ? (this.example?.simulation() ?? "online") : null,
    };
  }
}
