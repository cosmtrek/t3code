import type { EnvironmentId } from "@t3tools/contracts";
import type { ForkApiError } from "@t3tools/fork-client/http";
import type { ForkEvent } from "@t3tools/fork-client/sse";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AppState } from "react-native";

import { asForkError, forkRequest, subscribeToForkEvents } from "./forkApi";

const REFRESH_DEBOUNCE_MS = 250;
/** Linked thread state is read on fetch, not pushed; a slow poll keeps it from going stale. */
const POLL_INTERVAL_MS = 60_000;
/** A first read that fails is retried before the view shows an error: the server may be waking. */
const FIRST_READ_RETRY_MS = [2_000, 5_000, 10_000] as const;

/** The last good read of each resource, so a screen opened again shows it at once. */
const lastReads = new Map<string, unknown>();
const LAST_READS_LIMIT = 32;

function rememberRead(key: string, data: unknown) {
  lastReads.delete(key);
  lastReads.set(key, data);
  if (lastReads.size > LAST_READS_LIMIT) lastReads.delete(lastReads.keys().next().value!);
}

export interface ForkResource<T> {
  readonly data: T | null;
  readonly error: ForkApiError | null;
  /** Reads again now. */
  readonly refresh: () => void;
}

/**
 * One fork route, read again on the events `refreshOn` lets through, on reconnect (which also
 * covers the app's return to the foreground), and on a slow poll while the app is active.
 */
export function useForkResource<T>(
  environmentId: EnvironmentId,
  path: string,
  refreshOn: (event: ForkEvent) => boolean,
): ForkResource<T> {
  const key = `${environmentId}\u0000${path}`;
  const [state, setState] = useState<{
    readonly key: string;
    readonly data: T | null;
    readonly error: ForkApiError | null;
  }>(() => ({ key, data: (lastReads.get(key) as T | undefined) ?? null, error: null }));
  const request = useRef<(() => void) | null>(null);
  const shouldRefresh = useEffectEvent(refreshOn);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the route from the environment's server and follows its events and a poll
  useEffect(() => {
    const controller = new AbortController();
    // A read asked for mid-read runs once after it, so a burst of events does not pile up reads.
    let running = false;
    let again = false;
    let hasData = lastReads.has(key);
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const run = async () => {
      running = true;
      again = false;
      const outcome = await forkRequest<T>(environmentId, path, { signal: controller.signal }).then(
        (data) => ({ ok: true as const, data }),
        (raw: unknown) => ({ ok: false as const, error: asForkError(raw) }),
      );
      running = false;
      if (controller.signal.aborted) return;
      if (outcome.ok) {
        hasData = true;
        failures = 0;
        rememberRead(key, outcome.data);
        setState({ key, data: outcome.data, error: null });
      } else {
        const delay = hasData ? undefined : FIRST_READ_RETRY_MS[failures];
        if (delay !== undefined && !again) {
          failures += 1;
          retry = setTimeout(() => {
            retry = null;
            void run();
          }, delay);
        } else {
          // A failed refresh keeps what was shown, so a blip does not blank the screen.
          setState((current) => ({
            key,
            data: current.key === key ? current.data : null,
            error: outcome.error,
          }));
        }
      }
      if (again) void run();
    };
    const read = () => {
      if (running) {
        again = true;
        return;
      }
      if (retry !== null) clearTimeout(retry);
      retry = null;
      void run();
    };
    request.current = read;
    read();

    const bump = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        read();
      }, REFRESH_DEBOUNCE_MS);
    };
    const stop = subscribeToForkEvents(environmentId, (event) => {
      if (event.type === "reconnect" || shouldRefresh(event)) bump();
    });
    const poll = setInterval(() => {
      if (AppState.currentState === "active") bump();
    }, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      stop();
      clearInterval(poll);
      if (timer !== null) clearTimeout(timer);
      if (retry !== null) clearTimeout(retry);
      if (request.current === read) request.current = null;
    };
  }, [environmentId, path, key]);

  const current = state.key === key;
  return {
    data: current ? state.data : ((lastReads.get(key) as T | undefined) ?? null),
    error: current ? state.error : null,
    refresh: () => request.current?.(),
  };
}
