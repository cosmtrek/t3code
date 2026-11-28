import type * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../../config.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
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
  ChannelFileError,
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
  isAdapterUnreachableError,
  AdapterTransportError,
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

export class ChannelUnavailableError extends Schema.TaggedError<ChannelUnavailableError>()(
  "ChannelUnavailableError",
  {
    channelId: Schema.String,
    status: Schema.Literals([
      "disabled",
      "token_missing",
      "unreachable",
      "unauthorized",
      "incompatible",
      "needs_login",
      "collector_stopped",
      "online",
      "missing",
    ]),
    message: Schema.String,
  },
) {}

export class AdapterRequestError extends Schema.TaggedError<AdapterRequestError>()(
  "AdapterRequestError",
  { httpStatus: Schema.Number, code: Schema.String, message: Schema.String },
) {}

type HubError =
  | ChannelConfigError
  | ChannelFileError
  | ChannelUnavailableError
  | AdapterRequestError
  | AdapterUnreachableError
  | AdapterTransportError
  | PlatformError.PlatformError;

export const isChannelUnavailableError = Schema.is(ChannelUnavailableError);
export const isAdapterRequestError = Schema.is(AdapterRequestError);

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
  inflight: Map<
    string,
    Fiber.Fiber<{ readonly value: unknown; readonly stale: boolean }, HubError>
  >;
  /** Bumped on every invalidation; a read that started before one does not fill the cache. */
  generation: number;
  lastGood: Map<string, unknown>;
  scope: Scope.Closeable;
  closed: boolean;
  checking: Fiber.Fiber<void, HubError> | null;
  nextCheck: Fiber.Fiber<void, HubError> | null;
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
    ? new AdapterRequestError({
        httpStatus: response.status,
        code: redactToken(parsed.value.error.code, token),
        message: redactToken(parsed.value.error.message, token),
      })
    : new AdapterRequestError({
        httpStatus: response.status,
        code: "unknown",
        message: `The adapter answered HTTP ${response.status}.`,
      });
}

export interface ChannelHubOptions {
  readonly configPath: string;
  readonly now?: () => number;
  /** Tests pass their own transports; the default is loopback HTTP and the in-process example. */
  readonly transportFor?: (
    entry: ChannelConfigEntry,
  ) => Effect.Effect<ChannelTransport, HubError, Scope.Scope>;
  /** Tests run checks by hand. */
  readonly background?: boolean;
}

export const make = Effect.fn("ChannelHub.make")(function* (options: ChannelHubOptions) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Scope.Scope;
  const clock = yield* Clock.Clock;
  const now = options.now ?? (() => clock.currentTimeMillisUnsafe());
  const writes = yield* Semaphore.make(1);
  const readToken = yield* createTokenReader;
  let file: ChannelsFile | null = null;
  const runtimes = new Map<string, Runtime>();
  const listeners = new Set<(event: HubEvent) => void>();
  const revisions = new Map<string, number>();
  let example: ExampleChannel | null = null;
  const readFile = () =>
    readChannelsFile(options.configPath).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const writeFile = (next: ChannelsFile) =>
    writeChannelsFile(options.configPath, next).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
    );
  const start = Effect.fn("ChannelHub.start")(function* () {
    file = yield* readFile();
    for (const entry of file.channels) yield* startRuntime(entry);
  });

  const stop = Effect.fn("ChannelHub.stop")(function* () {
    for (const runtime of runtimes.values()) yield* closeRuntime(runtime);
    runtimes.clear();
    listeners.clear();
    example = null;
  });

  const subscribe = Effect.fn("ChannelHub.subscribe")((listener: (event: HubEvent) => void) =>
    Effect.sync(() => {
      listeners.add(listener);
      return Effect.sync(() => {
        listeners.delete(listener);
      });
    }),
  );

  function list(): ReadonlyArray<ChannelView> {
    return (file?.channels ?? []).flatMap((entry) => {
      const runtime = runtimes.get(entry.id);
      return runtime ? [view(runtime)] : [];
    });
  }

  function get(channelId: string): ChannelView | null {
    const runtime = runtimes.get(channelId);
    return runtime ? view(runtime) : null;
  }

  /**
   * Adds or replaces one channel. Ids are stable: a new channel without one gets one from its
   * name, and an existing one keeps its own.
   */
  const save = Effect.fn("ChannelHub.save")(function* (
    input: ChannelConfigEntry,
    options: { readonly create: boolean },
  ): Effect.fn.Return<ChannelView, HubError> {
    if (options.create && input.kind === "example") {
      return yield* new ChannelConfigError({
        message: "The example channel is built in; turn it on instead.",
      });
    }
    return yield* writes.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = file ?? (yield* restore(readFile()));
          const entry = yield* Effect.try({
            try: () =>
              validateChannelEntry(
                options.create && input.id === ""
                  ? {
                      ...input,
                      id: channelIdFor(input.name, new Set(current.channels.map((c) => c.id))),
                    }
                  : input,
              ),
            catch: (error) => error as ChannelConfigError,
          });
          const existing = current.channels.find((candidate) => candidate.id === entry.id);
          if (options.create && existing) {
            return yield* new ChannelConfigError({
              message: `A channel with the id "${entry.id}" already exists.`,
              field: "id",
            });
          }
          if (!options.create && !existing) {
            return yield* new ChannelConfigError({
              message: `No channel has the id "${entry.id}".`,
              field: "id",
            });
          }
          if (existing && existing.kind !== entry.kind) {
            return yield* new ChannelConfigError({
              message: "A channel's kind cannot change.",
              field: "id",
            });
          }
          const channels = existing
            ? current.channels.map((candidate) => (candidate.id === entry.id ? entry : candidate))
            : [...current.channels, entry];
          const next: ChannelsFile = { version: 1, channels };
          yield* writeFile(next);
          file = next;
          const previous = runtimes.get(entry.id);
          if (previous) yield* closeRuntime(previous);
          runtimes.delete(entry.id);
          const runtime = yield* startRuntime(entry);
          yield* publish({ type: "channels" });
          yield* publish({ type: "inbox", channelId: entry.id });
          if (entry.enabled) yield* restore(runCheck(runtime));
          return view(runtime);
        }),
      ),
    );
  });

  const remove = Effect.fn("ChannelHub.remove")(function* (
    channelId: string,
  ): Effect.fn.Return<boolean, HubError> {
    return yield* writes.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const current = file ?? (yield* restore(readFile()));
          const existing = current.channels.find((entry) => entry.id === channelId);
          if (!existing) return false;
          if (existing.kind === "example") {
            return yield* new ChannelConfigError({
              message: "The example channel is built in; turn it off instead.",
            });
          }
          const next: ChannelsFile = {
            version: 1,
            channels: current.channels.filter((entry) => entry.id !== channelId),
          };
          yield* writeFile(next);
          file = next;
          const previous = runtimes.get(channelId);
          if (previous) yield* closeRuntime(previous);
          runtimes.delete(channelId);
          yield* publish({ type: "channels" });
          yield* publish({ type: "inbox", channelId });
          return true;
        }),
      ),
    );
  });

  /** Runs every step now and returns the channel as it stands afterwards. */
  const test = Effect.fn("ChannelHub.test")(function* (
    channelId: string,
  ): Effect.fn.Return<ChannelView, HubError> {
    const runtime = yield* Effect.try({
      try: () => requireRuntime(channelId),
      catch: (error) => error as ChannelUnavailableError,
    });
    yield* runCheck(runtime, { force: true });
    return view(runtime);
  });

  /** Runs every step against an adapter without saving it or keeping what it read. */
  const probe = Effect.fn("ChannelHub.probe")(function* (draft: {
    readonly baseUrl: string;
    readonly tokenFile: string;
  }): Effect.fn.Return<ChannelProbe, HubError> {
    const address = yield* Effect.try({
      try: () => validateAdapterAddress(draft),
      catch: (error) => error as ChannelConfigError,
    });
    const runtime = yield* newRuntime({
      id: "",
      kind: "http-adapter",
      name: "",
      ...address,
      enabled: true,
    });
    const result = yield* evaluate(runtime).pipe(Effect.ensuring(closeRuntime(runtime)));
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
  });

  /** Switches the example channel to a made-up state, so every status can be seen in a browser. */
  const simulate = Effect.fn("ChannelHub.simulate")(function* (
    channelId: string,
    simulation: ExampleSimulation,
  ): Effect.fn.Return<ChannelView, HubError> {
    const runtime = yield* Effect.try({
      try: () => requireRuntime(channelId),
      catch: (error) => error as ChannelUnavailableError,
    });
    if (runtime.entry.kind !== "example" || example === null) {
      return yield* new ChannelConfigError({
        message: "Only the example channel can simulate a state.",
        field: "id",
      });
    }
    yield* example.setSimulation(simulation);
    // Like a real outage: what was read stays readable, only fresh reads are dropped.
    yield* dropCached(runtime);
    yield* runCheck(runtime, { force: true });
    return view(runtime);
  });

  /** A JSON GET through the channel. While the adapter is unreachable, the last answer is served. */
  const getJson = Effect.fn("ChannelHub.getJson")(function* <A>(
    channelId: string,
    path: string,
    schema: Schema.Decoder<A>,
    options: { readonly cacheMs?: number } = {},
  ): Effect.fn.Return<{ readonly value: A; readonly stale: boolean }, HubError> {
    const runtime = yield* Effect.try({
      try: () => requireRuntime(channelId),
      catch: (error) => error as ChannelUnavailableError,
    });
    const access = channelAccess(runtime.status);
    if (!access.read) {
      return yield* new ChannelUnavailableError({
        channelId: channelId,
        status: runtime.status,
        message: unavailableMessage(runtime),
      });
    }
    const cacheMs = options.cacheMs ?? LIST_CACHE_MS;
    const cached = runtime.cache.get(path);
    if (cached && now() - cached.at < cacheMs) {
      return { value: cached.value as A, stale: false };
    }
    if (access.stale)
      return yield* Effect.try({
        try: () => lastGood<A>(runtime, path),
        catch: (error) => error as ChannelUnavailableError,
      });
    // A path always decodes with the same schema, so a shared read fits every caller.
    const pending = runtime.inflight.get(path);
    if (pending)
      return (yield* Fiber.join(pending)) as { readonly value: A; readonly stale: boolean };
    const read = yield* readJson(runtime, path, schema).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (runtime.inflight.get(path) === read) runtime.inflight.delete(path);
        }),
      ),
      Effect.forkIn(runtime.scope),
    );
    runtime.inflight.set(path, read);
    return yield* Fiber.join(read);
  });

  const readJson = Effect.fn("ChannelHub.readJson")(function* <A>(
    runtime: Runtime,
    path: string,
    schema: Schema.Decoder<A>,
  ): Effect.fn.Return<{ readonly value: A; readonly stale: boolean }, HubError> {
    const channelId = runtime.entry.id;
    const generation = runtime.generation;
    const responseResult = yield* sendRequest(runtime, {
      method: "GET",
      path,
      token: runtime.token,
    }).pipe(Effect.result);
    if (responseResult._tag === "Failure") {
      const error = responseResult.failure;
      if (isAdapterUnreachableError(error)) {
        yield* runCheck(runtime).pipe(Effect.forkIn(runtime.scope));
        return yield* Effect.try({
          try: () => lastGood<A>(runtime, path),
          catch: (error) => error as ChannelUnavailableError,
        });
      }
      return yield* error;
    }
    const response = responseResult.success;
    if (response.status === 401 || response.status === 403) {
      yield* runCheck(runtime).pipe(Effect.forkIn(runtime.scope));
      return yield* new ChannelUnavailableError({
        channelId: channelId,
        status: "unauthorized",
        message: "The adapter refused the token.",
      });
    }
    if (response.status >= 400) return yield* adapterError(response, runtime.token);
    const decoded = Schema.decodeUnknownExit(schema)(parseJson(response));
    if (decoded._tag === "Failure") {
      return yield* new AdapterRequestError({
        httpStatus: 502,
        code: "invalid_response",
        message: `The adapter's answer to ${path.split("?")[0]} does not match protocol ${CHANNEL_PROTOCOL_VERSION}.`,
      });
    }
    const value = redactToken(decoded.value, runtime.token);
    if (runtime.generation === generation) runtime.cache.set(path, { at: now(), value });
    runtime.lastGood.delete(path);
    runtime.lastGood.set(path, value);
    if (runtime.lastGood.size > LAST_GOOD_LIMIT) {
      const oldest = runtime.lastGood.keys().next().value;
      if (oldest !== undefined) runtime.lastGood.delete(oldest);
    }
    return { value, stale: false };
  });

  /**
   * Every page of a list, following `nextCursor`. Stops after `maxPages` so a looping adapter
   * cannot hang a request; `complete` says whether the list ended. An item that does not decode
   * is left out and counted in `skipped`, so one bad record does not hide the rest.
   */
  const getAllPages = Effect.fn("ChannelHub.getAllPages")(function* <A>(
    channelId: string,
    path: string,
    itemSchema: Schema.Decoder<A>,
    options: { readonly cacheMs?: number; readonly maxPages: number },
  ): Effect.fn.Return<
    {
      readonly items: ReadonlyArray<A>;
      readonly stale: boolean;
      readonly complete: boolean;
      readonly skipped: number;
    },
    HubError
  > {
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
      const answer = yield* getJson(channelId, pagePath, RawPage, options);
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
  });

  const getMedia = Effect.fn("ChannelHub.getMedia")(function* (
    channelId: string,
    path: string,
  ): Effect.fn.Return<AdapterResponse, HubError> {
    const runtime = yield* Effect.try({
      try: () => requireRuntime(channelId),
      catch: (error) => error as ChannelUnavailableError,
    });
    if (!channelAccess(runtime.status).read || runtime.status === "unreachable") {
      return yield* new ChannelUnavailableError({
        channelId: channelId,
        status: runtime.status,
        message: unavailableMessage(runtime),
      });
    }
    const response = yield* sendRequest(runtime, {
      method: "GET",
      path,
      token: runtime.token,
      media: true,
    });
    if (response.status >= 400) return yield* adapterError(response, runtime.token);
    return response;
  });

  const postJson = Effect.fn("ChannelHub.postJson")(function* (
    channelId: string,
    path: string,
    body: unknown,
  ): Effect.fn.Return<unknown, HubError> {
    return yield* post(channelId, { path, body });
  });

  /** Hands the adapter a file; like media, it may take the adapter a while to pass it on. */
  const upload = Effect.fn("ChannelHub.upload")(function* (
    channelId: string,
    path: string,
    bytes: Uint8Array,
  ): Effect.fn.Return<unknown, HubError> {
    return yield* post(channelId, { path, bytes, media: true });
  });

  const post = Effect.fn("ChannelHub.post")(function* (
    channelId: string,
    request: Pick<AdapterRequest, "path" | "body" | "bytes" | "media">,
  ): Effect.fn.Return<unknown, HubError> {
    const runtime = yield* Effect.try({
      try: () => requireRuntime(channelId),
      catch: (error) => error as ChannelUnavailableError,
    });
    if (!channelAccess(runtime.status).send) {
      return yield* new ChannelUnavailableError({
        channelId: channelId,
        status: runtime.status,
        message: unavailableMessage(runtime),
      });
    }
    const responseResult = yield* sendRequest(runtime, {
      ...request,
      method: "POST",
      token: runtime.token,
    }).pipe(Effect.result);
    if (responseResult._tag === "Failure") {
      const error = responseResult.failure;
      if (isAdapterUnreachableError(error)) {
        yield* runCheck(runtime).pipe(Effect.forkIn(runtime.scope));
        return yield* new ChannelUnavailableError({
          channelId: channelId,
          status: "unreachable",
          message: "The adapter cannot be reached.",
        });
      }
      return yield* error;
    }
    const response = responseResult.success;
    if (response.status >= 400) return yield* adapterError(response, runtime.token);
    return redactToken(parseJson(response), runtime.token);
  });

  /** Drops cached lists so the next read asks the adapter. */
  const invalidate = Effect.fn("ChannelHub.invalidate")(function* (channelId: string) {
    const runtime = runtimes.get(channelId);
    if (runtime) yield* dropCached(runtime);
  });

  /** Drops cached answers whose path starts with one of `prefixes`, or all of them. */
  const dropCached = Effect.fn("ChannelHub.dropCached")(
    (runtime: Runtime, prefixes?: ReadonlyArray<string>) =>
      Effect.sync(() => {
        runtime.generation += 1;
        bumpRevision(runtime.entry.id);
        runtime.inflight.clear();
        if (prefixes === undefined) {
          runtime.cache.clear();
          return;
        }
        for (const path of runtime.cache.keys()) {
          if (prefixes.some((prefix) => path.startsWith(prefix))) runtime.cache.delete(path);
        }
      }),
  );

  function lastGood<T>(runtime: Runtime, path: string): { value: T; stale: boolean } {
    if (!runtime.lastGood.has(path)) {
      throw new ChannelUnavailableError({
        channelId: runtime.entry.id,
        status: "unreachable",
        message: "The adapter cannot be reached and nothing was read from it yet.",
      });
    }
    return { value: runtime.lastGood.get(path) as T, stale: true };
  }

  function unavailableMessage(runtime: Runtime): string {
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

  function requireRuntime(channelId: string): Runtime {
    const runtime = runtimes.get(channelId);
    if (!runtime)
      throw new ChannelUnavailableError({
        channelId: channelId,
        status: "missing",
        message: "No such channel.",
      });
    return runtime;
  }

  function revision(channelId: string): number {
    return revisions.get(channelId) ?? 0;
  }

  function bumpRevision(channelId: string) {
    revisions.set(channelId, revision(channelId) + 1);
  }

  const publish = Effect.fn("ChannelHub.publish")(function* (event: HubEvent) {
    if (event.type === "inbox") bumpRevision(event.channelId);
    else if (event.type === "channels") {
      for (const channelId of runtimes.keys()) bumpRevision(channelId);
    }
    for (const listener of listeners) {
      yield* Effect.try({ try: () => listener(event), catch: () => null }).pipe(Effect.ignore);
    }
  });

  const onEvent = Effect.fn("ChannelHub.onEvent")(function* (
    runtime: Runtime,
    event: ChannelEvent,
  ) {
    if ("conversationId" in event && event.conversationId !== undefined) {
      yield* dropCached(runtime, [
        "/conversations?",
        `/conversations/${encodeURIComponent(event.conversationId)}/`,
      ]);
    } else {
      yield* dropCached(runtime);
    }
    if (event.type === "health.changed") {
      yield* runCheck(runtime).pipe(Effect.forkIn(runtime.scope));
      return;
    }
    yield* publish({ type: "inbox", channelId: runtime.entry.id });
  });

  /** One check at a time per channel; a forced check waits for the running one and runs again. */
  const check = Effect.fn("ChannelHub.check")(function* (runtime: Runtime) {
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
    const result = yield* evaluate(runtime);
    runtime.lastCheckedAt = DateTime.formatIso(DateTime.makeUnsafe(now()));
    if (result.status !== runtime.status) {
      runtime.statusSince = runtime.lastCheckedAt;
      runtime.status = result.status;
      yield* dropCached(runtime);
    }
    runtime.steps = result.steps;
    if (result.health !== undefined) runtime.health = result.health;
    if (result.config) runtime.config = result.config;
    if (before !== material()) {
      yield* publish({ type: "channels" });
      yield* publish({ type: "inbox", channelId: runtime.entry.id });
    } else if (fullBefore !== full()) {
      yield* publish({ type: "sync", channelId: runtime.entry.id });
    }
  });

  const evaluate = Effect.fn("ChannelHub.evaluate")(function* (runtime: Runtime): Effect.fn.Return<
    {
      status: ChannelStatus;
      steps: ChannelCheckStep[];
      /** null drops what the last check read; absent keeps it. */
      health?: ChannelHealth | null;
      config?: AdapterConfig;
    },
    HubError
  > {
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
      const token = yield* readToken(runtime.entry.tokenFile);
      if (!token.ok) {
        runtime.token = null;
        return fail("token_missing", "token", token.reason);
      }
      runtime.token = token.token;
      runtime.tokenWarning = token.warning;
      steps.push({ id: "token", ok: true, detail: "" });
    }
    const started = now();
    const responseResult = yield* sendRequest(runtime, {
      method: "GET",
      path: "/health",
      token: runtime.token,
    }).pipe(Effect.result);
    if (responseResult._tag === "Failure") {
      const error = responseResult.failure;
      return fail(
        "unreachable",
        "connect",
        `${runtime.entry.baseUrl || "The adapter"} cannot be reached: ${redactToken((error as Error).message, runtime.token)}`,
      );
    }
    const response = responseResult.success;
    if (response.status === 401 || response.status === 403) {
      steps.push({ id: "connect", ok: true, detail: `${now() - started} ms` });
      return fail(
        "unauthorized",
        "auth",
        `The adapter refused the token (HTTP ${response.status}).`,
      );
    }
    if (response.status >= 400) {
      return fail("unreachable", "connect", `The adapter answered HTTP ${response.status}.`);
    }
    steps.push({ id: "connect", ok: true, detail: `${now() - started} ms` });
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
    const configResult = yield* sendRequest(runtime, {
      method: "GET",
      path: "/config",
      token: runtime.token,
    }).pipe(Effect.result);
    if (configResult._tag === "Success") {
      const configResponse = configResult.success;
      const decoded = decodeConfig(redactToken(parseJson(configResponse), runtime.token));
      if (configResponse.status < 400 && decoded._tag === "Success") config = decoded.value;
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
  });

  function view(runtime: Runtime): ChannelView {
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
      simulation: entry.kind === "example" ? (example?.simulation() ?? "online") : null,
    };
  }
  const closeRuntime = Effect.fn("ChannelHub.closeRuntime")(function* (runtime: Runtime) {
    runtime.closed = true;
    yield* Scope.close(runtime.scope, Exit.void);
  });
  const sendRequest = Effect.fn("ChannelHub.request")(function* (
    runtime: Runtime,
    input: AdapterRequest,
  ): Effect.fn.Return<AdapterResponse, HubError> {
    if (runtime.closed) return yield* Effect.interrupt;
    const fiber = yield* runtime.transport
      .request(input)
      .pipe(Effect.provideService(Scope.Scope, runtime.scope), Effect.forkIn(runtime.scope));
    return yield* Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber)));
  });
  const newRuntime = Effect.fn("ChannelHub.newRuntime")(function* (
    entry: ChannelConfigEntry,
  ): Effect.fn.Return<Runtime, HubError> {
    const channelScope = yield* Scope.fork(scope);
    const transport = yield* (
      options.transportFor
        ? options.transportFor(entry)
        : entry.kind === "example"
          ? Effect.gen(function* () {
              example ??= yield* createExampleChannel({ now });
              return example;
            })
          : httpTransport(entry.baseUrl).pipe(Effect.provideService(HttpClient.HttpClient, http))
    ).pipe(
      Effect.provideService(Scope.Scope, channelScope),
      Effect.onError(() => Scope.close(channelScope, Exit.void)),
    );
    return {
      entry,
      transport,
      status: entry.enabled ? "unreachable" : "disabled",
      statusSince: DateTime.formatIso(DateTime.makeUnsafe(now())),
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
      scope: channelScope,
      closed: false,
      checking: null,
      nextCheck: null,
      retryMs: null,
    };
  });
  const startRuntime = Effect.fn("ChannelHub.startRuntime")(function* (
    entry: ChannelConfigEntry,
  ): Effect.fn.Return<Runtime, HubError> {
    const runtime = yield* newRuntime(entry);
    runtimes.set(entry.id, runtime);
    if (entry.enabled && options.background !== false) {
      yield* runCheck(runtime).pipe(Effect.forkIn(runtime.scope, { startImmediately: true }));
      yield* followEvents(runtime).pipe(Effect.forkIn(runtime.scope));
    }
    return runtime;
  });
  const scheduleCheck = Effect.fn("ChannelHub.scheduleCheck")(function* (runtime: Runtime) {
    if (options.background === false || runtime.closed || !runtime.entry.enabled) return;
    if (runtime.nextCheck !== null) yield* Fiber.interrupt(runtime.nextCheck);
    const next = nextCheckDelay(runtime.status, runtime.retryMs);
    runtime.retryMs = next.retryMs;
    runtime.nextCheck = yield* Effect.sleep(next.delayMs).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          runtime.nextCheck = null;
          return runCheck(runtime);
        }),
      ),
      Effect.forkIn(runtime.scope),
    );
  });
  const runCheck = Effect.fn("ChannelHub.runCheck")(function* (
    runtime: Runtime,
    checkOptions: { readonly force?: boolean } = {},
  ): Effect.fn.Return<void, HubError> {
    if (runtime.closed) return yield* Effect.interrupt;
    if (runtime.checking) {
      yield* Fiber.join(runtime.checking);
      if (!checkOptions.force) return;
    }
    if (runtime.closed) return yield* Effect.interrupt;
    const checking = yield* check(runtime).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          runtime.checking = null;
          return scheduleCheck(runtime);
        }),
      ),
      Effect.forkIn(runtime.scope),
    );
    runtime.checking = checking;
    yield* Fiber.join(checking);
  });
  const followEvents = Effect.fn("ChannelHub.followEvents")(function* (
    runtime: Runtime,
  ): Effect.fn.Return<void, HubError> {
    let delay = EVENT_RETRY_MIN_MS;
    while (!runtime.closed) {
      if (runtime.checking) yield* Fiber.join(runtime.checking);
      if (channelAccess(runtime.status).read && runtime.status !== "unreachable") {
        const result = yield* runtime.transport.events(runtime.token).pipe(
          Stream.runForEach((event) => onEvent(runtime, event)),
          Effect.result,
        );
        if (result._tag === "Success") delay = EVENT_RETRY_MIN_MS;
        else yield* runCheck(runtime).pipe(Effect.forkIn(runtime.scope));
      }
      yield* Effect.sleep(delay);
      delay = Math.min(delay * 2, EVENT_RETRY_MAX_MS);
    }
  });
  yield* Effect.addFinalizer(() => stop());
  return {
    start,
    stop,
    subscribe,
    list,
    get,
    save,
    remove,
    test,
    probe,
    simulate,
    getJson,
    getAllPages,
    getMedia,
    postJson,
    upload,
    invalidate,
    revision,
    publish,
  };
});

export class ChannelHub extends Context.Service<
  ChannelHub,
  Effect.Success<ReturnType<typeof make>>
>()("t3/fork/channels/hub/ChannelHub") {}

export const layer = Layer.effect(
  ChannelHub,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return yield* make({ configPath: path.join(config.stateDir, "channels", "channels.json") });
  }),
);
