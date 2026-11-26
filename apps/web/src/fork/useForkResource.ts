import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { ForkApiError, forkRequest, subscribeForkEvents } from "./forkApiAccess";

export interface ForkEvent {
  readonly type: string;
  readonly channelId?: string;
  readonly botId?: string;
  /** A `bot-activity` event's line, and the thread it came from. */
  readonly text?: string;
  readonly threadId?: string;
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
/** A first read that fails is retried before the view shows an error: the adapter may be waking. */
const FIRST_READ_RETRY_MS = [2_000, 5_000, 10_000] as const;

const asForkError = (error: unknown) =>
  error instanceof ForkApiError
    ? error
    : new ForkApiError(0, "network", error instanceof Error ? error.message : String(error));

const isRetryable = (error: ForkApiError) =>
  error.status === 0 || error.status >= 500 || error.code === "unreachable";

export interface ForkResource<T> {
  readonly data: T | null;
  readonly error: ForkApiError | null;
  readonly loading: boolean;
  /** Reads again; resolves once a read that started after the call has settled. */
  readonly refresh: () => Promise<void>;
}

export function useForkResource<T>(
  environmentId: EnvironmentId | null,
  path: string | null,
  refreshOn: ForkRefreshFilter = () => true,
): ForkResource<T> {
  const key = environmentId === null || path === null ? null : `${environmentId}\u0000${path}`;
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly data: T | null;
    readonly error: ForkApiError | null;
    readonly loading: boolean;
  }>({ key: null, data: null, error: null, loading: false });
  const request = useRef<((done?: () => void) => void) | null>(null);
  const shouldRefresh = useEffectEvent(refreshOn);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the resource from the environment's server and follows its events and a visibility-aware poll
  useEffect(() => {
    if (environmentId === null || path === null) return;
    const controller = new AbortController();
    // A refresh asked for mid-read waits for that read and runs once after it, instead of
    // aborting it: under a burst of events, aborting would never let a slow read finish.
    let running = false;
    let again = false;
    let waiters: Array<() => void> = [];
    let hasData = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      running = true;
      again = false;
      const owned = waiters;
      waiters = [];
      setState((current) =>
        current.key === key
          ? // With nothing to show, a retry reads as loading, not as the last error.
            { ...current, error: hasData ? current.error : null, loading: true }
          : { key, data: null, error: null, loading: true },
      );
      const outcome = await forkRequest<T>(environmentId, path, { signal: controller.signal }).then(
        (data) => ({ ok: true as const, data }),
        (raw: unknown) => ({ ok: false as const, raw }),
      );
      if (!controller.signal.aborted) {
        if (outcome.ok) {
          hasData = true;
          failures = 0;
          setState({ key, data: outcome.data, error: null, loading: false });
        } else {
          const error = asForkError(outcome.raw);
          const delay = hasData || !isRetryable(error) ? undefined : FIRST_READ_RETRY_MS[failures];
          if (delay !== undefined) {
            failures += 1;
            // A refresh asked for meanwhile runs right away instead.
            if (!again) {
              retry = setTimeout(() => {
                retry = null;
                void run();
              }, delay);
            }
          } else {
            // A failed refresh keeps what was shown, so a blip does not blank the view.
            setState((current) => ({
              key,
              data: current.key === key ? current.data : null,
              error,
              loading: false,
            }));
          }
        }
      }
      running = false;
      for (const done of owned) done();
      if (again && !controller.signal.aborted) void run();
    };

    const requestRead = (done?: () => void) => {
      if (done) waiters.push(done);
      if (running) {
        again = true;
        return;
      }
      if (retry !== null) {
        clearTimeout(retry);
        retry = null;
      }
      void run();
    };
    request.current = requestRead;
    requestRead();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        requestRead();
      }, REFRESH_DEBOUNCE_MS);
    };
    const stop = subscribeToForkEvents(environmentId, (event) => {
      if (event.type === "reconnect" || shouldRefresh(event)) bump();
    });
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") bump();
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      stop();
      clearInterval(poll);
      if (timer !== null) clearTimeout(timer);
      if (retry !== null) clearTimeout(retry);
      if (request.current === requestRead) request.current = null;
      for (const done of waiters) done();
    };
  }, [environmentId, path, key]);

  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: key !== null && (!current || state.loading),
    refresh: () =>
      new Promise<void>((resolve) => {
        if (request.current) request.current(resolve);
        else resolve();
      }),
  };
}
