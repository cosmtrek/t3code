import type { EnvironmentId } from "@t3tools/contracts";
import { botWorkThreadKeys, type BotSummary } from "@t3tools/fork-client/bots";
import { ForkApiError } from "@t3tools/fork-client/http";
import type { ForkEvent } from "@t3tools/fork-client/sse";
import { useEffect, useSyncExternalStore } from "react";

import { useEnvironments } from "../../state/environments";
import { forkRequest, subscribeToForkEvents } from "../forkApi";

export interface BotListing {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly bots: ReadonlyArray<BotSummary>;
}

const REFRESH_DEBOUNCE_MS = 1_000;
/** A read that failed (still connecting, server restarting) is tried again; no event may follow. */
const RETRY_MS = [2_000, 5_000, 10_000] as const;

const isBotEvent = (event: ForkEvent) => event.type === "bots" || event.type === "reconnect";

/**
 * Each environment's `/bots`, read once however many views show it. An environment whose server
 * has no bots route (404) or no bots drops out; a blip keeps what was last read.
 */
let listings: ReadonlyMap<EnvironmentId, BotListing> = new Map();
const changeListeners = new Set<() => void>();
const watchers = new Map<EnvironmentId, { count: number; label: string; stop: () => void }>();

function setListing(environmentId: EnvironmentId, listing: BotListing | null) {
  if (listing === null && !listings.has(environmentId)) return;
  const next = new Map(listings);
  if (listing === null) next.delete(environmentId);
  else next.set(environmentId, listing);
  listings = next;
  for (const listener of changeListeners) listener();
}

function startWatching(environmentId: EnvironmentId): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: { again: boolean } | null = null;
  let failures = 0;
  const schedule = (delay: number) => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      load();
    }, delay);
  };
  const load = () => {
    if (running) {
      running.again = true;
      return;
    }
    const run = { again: false };
    running = run;
    forkRequest<{ bots: ReadonlyArray<BotSummary> }>(environmentId, "/bots")
      .then(
        (body) => {
          if (stopped) return;
          failures = 0;
          const label = watchers.get(environmentId)?.label ?? "";
          setListing(
            environmentId,
            body.bots.length === 0 ? null : { environmentId, label, bots: body.bots },
          );
        },
        (error: unknown) => {
          if (stopped) return;
          if (!(error instanceof ForkApiError) || error.status === 0 || error.status >= 500) {
            schedule(RETRY_MS[failures] ?? 30_000);
            failures += 1;
          } else if (error.status === 404) {
            setListing(environmentId, null);
          }
        },
      )
      .finally(() => {
        running = null;
        if (run.again && !stopped) load();
      });
  };
  load();
  const unsubscribe = subscribeToForkEvents(environmentId, (event) => {
    if (isBotEvent(event)) schedule(REFRESH_DEBOUNCE_MS);
  });
  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}

function watch(environmentId: EnvironmentId, label: string): () => void {
  const current = watchers.get(environmentId);
  if (current) {
    current.count += 1;
    current.label = label;
  } else {
    watchers.set(environmentId, { count: 1, label, stop: startWatching(environmentId) });
  }
  return () => {
    const watcher = watchers.get(environmentId);
    if (!watcher) return;
    watcher.count -= 1;
    if (watcher.count === 0) {
      watcher.stop();
      watchers.delete(environmentId);
    }
  };
}

const subscribe = (listener: () => void) => {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
};
const getListings = () => listings;

/** Each connected environment's bots, in the order of the environment list. */
export function useBotListings(): ReadonlyArray<BotListing> {
  const { environments } = useEnvironments();
  const connected = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => [environment.environmentId, environment.label] as const);
  const connectedKey = JSON.stringify(connected);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each connected environment's bots and follows its server events
  useEffect(() => {
    const targets = JSON.parse(connectedKey) as ReadonlyArray<readonly [EnvironmentId, string]>;
    const stops = targets.map(([environmentId, label]) => watch(environmentId, label));
    return () => {
      for (const stop of stops) stop();
    };
  }, [connectedKey]);

  const current = useSyncExternalStore(subscribe, getListings);
  // A reconnecting environment keeps its last read, so its rows do not flash out and back.
  return environments.flatMap((environment) => {
    const listing = current.get(environment.environmentId);
    return listing ? [{ ...listing, label: environment.label }] : [];
  });
}

/**
 * The thread list without the bots' own work threads: each bot's row stands for its thread.
 * Keyed on the joined keys, so the compiler's memo holds while the listing only re-reads.
 */
export function useWithoutBotWorkThreads<Thread extends ThreadLike>(
  threads: ReadonlyArray<Thread>,
): ReadonlyArray<Thread> {
  return withoutThreads(threads, botWorkThreadKeys(useBotListings()).join("\n"));
}

interface ThreadLike {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}

function withoutThreads<Thread extends ThreadLike>(
  threads: ReadonlyArray<Thread>,
  hidden: string,
): ReadonlyArray<Thread> {
  if (hidden === "") return threads;
  const keys = new Set(hidden.split("\n"));
  return threads.filter((thread) => !keys.has(`${thread.environmentId}:${thread.id}`));
}
