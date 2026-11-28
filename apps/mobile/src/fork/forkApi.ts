/**
 * The fork's `/api/fork/*` routes from the phone. Access comes from the same media ticket the
 * device hub uses, so remote and relay environments work as they do on web.
 */
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import { ForkApiError, forkApiErrorFrom } from "@t3tools/fork-client/http";
import { createSseParser, type ForkEvent } from "@t3tools/fork-client/sse";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { environmentSession } from "../state/session";

const FORK_API_BASE_PATH = "/api/fork";

const forkAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: FORK_API_BASE_PATH });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`mobile-fork-api-access:${environmentId}`)),
);

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

const forkUrl = (access: DeviceHubAccess, path: string) =>
  withDeviceHubQuery(`${access.httpBase}${path}`, access);

/** `path` is below `/api/fork`, such as `/bots`. Renews the ticket once on 401. */
export async function forkRequest<T>(
  environmentId: EnvironmentId,
  path: string,
  init: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly signal?: AbortSignal;
  } = {},
): Promise<T> {
  const send = (access: DeviceHubAccess) =>
    fetch(forkUrl(access, path), {
      method: init.method ?? "GET",
      credentials: access.credentials ? "include" : "omit",
      ...(init.body === undefined
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
  if (!response.ok) throw await forkApiErrorFrom(response);
  return (await response.json()) as T;
}

export const asForkError = (error: unknown) =>
  error instanceof ForkApiError
    ? error
    : new ForkApiError(0, "network", error instanceof Error ? error.message : String(error));

/** A response this long is dropped and the stream reopened: XHR keeps the whole body in memory. */
const STREAM_BODY_LIMIT = 1_000_000;

/**
 * React Native has no `EventSource`. XHR hands over the body as it grows, which is enough for SSE;
 * `onEnd` fires once, whether the server closed the stream or the request failed.
 */
function openEventStream(
  url: string,
  withCredentials: boolean,
  handlers: { readonly onOpen: () => void; readonly onData: (data: string) => void },
  onEnd: (status: number) => void,
): () => void {
  const xhr = new XMLHttpRequest();
  let read = 0;
  let ended = false;
  const parse = createSseParser((_event, data) => handlers.onData(data));
  const end = () => {
    if (ended) return;
    ended = true;
    onEnd(xhr.status);
  };
  // Set before `send`: React Native streams the body only to a request that listens for it.
  xhr.onreadystatechange = () => {
    if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED && xhr.status === 200) {
      handlers.onOpen();
    }
  };
  xhr.onprogress = () => {
    const text = xhr.responseText;
    parse(text.slice(read));
    read = text.length;
    if (read > STREAM_BODY_LIMIT) {
      xhr.abort();
      end();
    }
  };
  xhr.onload = end;
  xhr.onerror = end;
  xhr.ontimeout = end;
  xhr.open("GET", url);
  xhr.withCredentials = withCredentials;
  xhr.setRequestHeader("accept", "text/event-stream");
  xhr.send();
  return () => {
    ended = true;
    xhr.onreadystatechange = null;
    xhr.onprogress = null;
    xhr.abort();
  };
}

/**
 * Follows the environment's fork events. The stream does not survive the background, so it closes
 * there and reopens on return, reporting `reconnect` so views read what they missed.
 */
function followForkEvents(
  environmentId: EnvironmentId,
  onEvent: (event: ForkEvent) => void,
): () => void {
  let closed = false;
  let stop: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let generation = 0;

  const disconnect = () => {
    generation += 1;
    if (retry !== null) clearTimeout(retry);
    retry = null;
    stop?.();
    stop = null;
  };
  const connect = async (renew: boolean) => {
    const owned = ++generation;
    const access = await readForkAccess(environmentId, { renew });
    if (closed || owned !== generation) return;
    if (access === null) {
      retry = setTimeout(() => void connect(true), 10_000);
      return;
    }
    stop = openEventStream(
      forkUrl(access, "/inbox/events"),
      access.credentials,
      {
        onOpen: () => {
          if (failures > 0) onEvent({ type: "reconnect" });
          failures = 0;
        },
        onData: (data) => {
          try {
            onEvent(JSON.parse(data) as ForkEvent);
          } catch {
            // A frame this client does not understand.
          }
        },
      },
      () => {
        stop = null;
        if (closed || owned !== generation) return;
        failures += 1;
        // A dropped stream may be an expired ticket; reading again catches up on what was missed.
        onEvent({ type: "reconnect" });
        retry = setTimeout(() => void connect(true), Math.min(30_000, 1_000 * 2 ** failures));
      },
    );
  };

  const appState = AppState.addEventListener("change", (state) => {
    if (state === "background") return disconnect();
    if (state === "active" && stop === null && retry === null) {
      failures = 0;
      onEvent({ type: "reconnect" });
      void connect(true);
    }
  });
  if (AppState.currentState !== "background") void connect(false);
  return () => {
    closed = true;
    appState.remove();
    disconnect();
  };
}

type Listener = (event: ForkEvent) => void;

/** One stream per environment, shared by every mounted view (Android mounts Home twice). */
const streams = new Map<
  EnvironmentId,
  { readonly listeners: Set<Listener>; readonly close: () => void }
>();

export function subscribeToForkEvents(
  environmentId: EnvironmentId,
  listener: Listener,
): () => void {
  let stream = streams.get(environmentId);
  if (!stream) {
    const listeners = new Set<Listener>();
    const close = followForkEvents(environmentId, (event) => {
      for (const current of listeners) current(event);
    });
    stream = { listeners, close };
    streams.set(environmentId, stream);
  }
  stream.listeners.add(listener);
  const owned = stream;
  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size === 0) {
      owned.close();
      streams.delete(environmentId);
    }
  };
}
