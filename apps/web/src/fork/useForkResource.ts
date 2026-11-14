import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { ForkApiError, forkRequest, subscribeForkEvents } from "./forkApiAccess";

export interface ForkEvent {
  readonly type: string;
  readonly channelId?: string;
}

type Listener = (event: ForkEvent) => void;

/** One event stream per environment, shared by every mounted view. */
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
    const close = subscribeForkEvents(environmentId, (event) => {
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

/** Refetch on these events; a channel-scoped event only refreshes views of that channel. */
export type ForkRefreshFilter = (event: ForkEvent) => boolean;

const REFRESH_DEBOUNCE_MS = 250;
/** Linked thread state is read on fetch, not pushed; a slow poll keeps it from going stale. */
const POLL_INTERVAL_MS = 60_000;

export interface ForkResource<T> {
  readonly data: T | null;
  readonly error: ForkApiError | null;
  readonly loading: boolean;
  readonly refresh: () => void;
}

export function useForkResource<T>(
  environmentId: EnvironmentId | null,
  path: string | null,
  refreshOn: ForkRefreshFilter = () => true,
): ForkResource<T> {
  const key = environmentId === null || path === null ? null : `${environmentId}\u0000${path}`;
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly version: number;
    readonly data: T | null;
    readonly error: ForkApiError | null;
  }>({ key: null, version: -1, data: null, error: null });
  const [version, setVersion] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the resource from the environment's server
  useEffect(() => {
    if (environmentId === null || path === null) return;
    const controller = new AbortController();
    const settle = (data: T | null, error: ForkApiError | null) =>
      setState((current) => ({
        key,
        version,
        // A failed refresh keeps what was shown, so a blip does not blank the view.
        data: error !== null && current.key === key ? current.data : data,
        error,
      }));
    forkRequest<T>(environmentId, path, { signal: controller.signal }).then(
      (data) => {
        if (!controller.signal.aborted) settle(data, null);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        settle(
          null,
          error instanceof ForkApiError
            ? error
            : new ForkApiError(
                0,
                "network",
                error instanceof Error ? error.message : String(error),
              ),
        );
      },
    );
    return () => controller.abort();
  }, [environmentId, path, key, version]);

  const shouldRefresh = useEffectEvent(refreshOn);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounces server events and a visibility-aware poll into refetches
  useEffect(() => {
    if (environmentId === null || path === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion((value) => value + 1);
      }, REFRESH_DEBOUNCE_MS);
    };
    const stop = subscribeToForkEvents(environmentId, (event) => {
      if (event.type === "reconnect" || shouldRefresh(event)) bump();
    });
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, POLL_INTERVAL_MS);
    return () => {
      stop();
      clearInterval(poll);
      if (timer !== null) clearTimeout(timer);
    };
  }, [environmentId, path]);

  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: key !== null && (!current || state.version !== version),
    refresh: () => setVersion((value) => value + 1),
  };
}
