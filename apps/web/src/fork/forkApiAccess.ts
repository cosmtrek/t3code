/**
 * Address and credential for the fork's `/api/fork/*` routes on any environment. A plain fetch
 * with the page's session works only for the environment the page came from, so this mints the
 * same media ticket the device hub uses. See "Inbox seams" in FORK.md.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSession } from "../state/session";

const FORK_API_BASE_PATH = "/api/fork";
/** Media tickets live five minutes on the server; renew a little before that. */
const TICKET_RENEW_AFTER_MS = 4 * 60_000;
const mintedAt = new WeakMap<DeviceHubAccess, number>();

const forkAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: FORK_API_BASE_PATH }).pipe(
        Effect.tap((access) =>
          Clock.currentTimeMillis.pipe(Effect.map((now) => mintedAt.set(access, now))),
        ),
      );
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`fork-api-access:${environmentId}`)),
);

const EMPTY_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("fork-api-access:empty"),
);

export function useForkAccess(environmentId: EnvironmentId | null): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : forkAccessAtom(environmentId),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}

/** Mints a fresh ticket, for a media request that failed on an expired one. */
export function renewForkAccess(environmentId: EnvironmentId): void {
  appAtomRegistry.refresh(forkAccessAtom(environmentId));
}

/**
 * Renews a ticket about to expire. A link cannot see its own failure the way an image can, so
 * links call this when the pointer or focus reaches them, before the click.
 */
export function renewStaleForkAccess(environmentId: EnvironmentId, access: DeviceHubAccess): void {
  if (access.credentials) return;
  if (Date.now() - (mintedAt.get(access) ?? 0) > TICKET_RENEW_AFTER_MS) {
    renewForkAccess(environmentId);
  }
}

/** The current access, or a fresh ticket after a 401. Resolves null when none can be had. */
function readForkAccess(
  environmentId: EnvironmentId,
  options: { readonly renew?: boolean } = {},
): Promise<DeviceHubAccess | null> {
  const atom = forkAccessAtom(environmentId);
  if (options.renew) appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}

export function forkUrl(access: DeviceHubAccess, path: string): string {
  return withDeviceHubQuery(`${access.httpBase}${path}`, access);
}

// @effect-diagnostics-next-line extendsNativeError:off -- thrown from plain fetch code and caught by React views, never in an Effect channel.
export class ForkApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;
  constructor(status: number, code: string, message: string, field?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

async function errorFrom(response: Response): Promise<ForkApiError> {
  try {
    const body = (await response.json()) as { code?: string; message?: string; field?: string };
    return new ForkApiError(
      response.status,
      body.code ?? "unknown",
      body.message ?? `The server answered ${response.status}.`,
      body.field,
    );
  } catch {
    return new ForkApiError(response.status, "unknown", `The server answered ${response.status}.`);
  }
}

/** `path` is below `/api/fork`, such as `/inbox/conversations?channelId=x`. Renews the ticket once on 401. */
export async function forkRequest<T>(
  environmentId: EnvironmentId,
  path: string,
  init: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    /** A file, sent as the request's raw body instead of JSON. */
    readonly file?: Blob;
    readonly signal?: AbortSignal;
  } = {},
): Promise<T> {
  const send = async (access: DeviceHubAccess) =>
    fetch(forkUrl(access, path), {
      method: init.method ?? "GET",
      credentials: access.credentials ? "include" : "same-origin",
      ...(init.file !== undefined
        ? { headers: { "content-type": "application/octet-stream" }, body: init.file }
        : init.body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  const access = await readForkAccess(environmentId);
  if (access === null) {
    throw new ForkApiError(0, "unreachable", "This environment is not connected.");
  }
  let response = await send(access);
  if (response.status === 401) {
    const renewed = await readForkAccess(environmentId, { renew: true });
    if (renewed !== null) response = await send(renewed);
  }
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as T;
}

/** Follows the environment's fork events; reconnects with a fresh ticket when the stream drops. */
export function subscribeForkEvents(
  environmentId: EnvironmentId,
  onEvent: (event: {
    readonly type: string;
    readonly channelId?: string;
    readonly botId?: string;
  }) => void,
): () => void {
  let closed = false;
  let source: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  const connect = async (renew: boolean) => {
    const access = await readForkAccess(environmentId, { renew });
    if (closed) return;
    if (access === null) {
      retry = setTimeout(() => void connect(true), 10_000);
      return;
    }
    source = new EventSource(forkUrl(access, "/inbox/events"), {
      withCredentials: access.credentials,
    });
    source.addEventListener("open", () => {
      // Back after a drop: what changed meanwhile was not pushed, so refetch.
      if (failures > 0) onEvent({ type: "reconnect" });
      failures = 0;
    });
    source.addEventListener("message", (message) => {
      try {
        onEvent(JSON.parse(message.data as string));
      } catch {
        // A frame this client does not understand.
      }
    });
    source.addEventListener("error", () => {
      source?.close();
      source = null;
      if (closed) return;
      failures += 1;
      // A dropped stream may be an expired ticket; refetching catches up on what was missed.
      onEvent({ type: "reconnect" });
      retry = setTimeout(() => void connect(true), Math.min(30_000, 1_000 * 2 ** failures));
    });
  };
  void connect(false);
  return () => {
    closed = true;
    if (retry !== null) clearTimeout(retry);
    source?.close();
  };
}
