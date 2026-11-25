import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useEnvironments } from "../state/environments";
import { ForkApiError, forkRequest } from "./forkApiAccess";
import { subscribeToForkEvents, type ForkEvent } from "./useForkResource";

const REFRESH_DEBOUNCE_MS = 1_000;
/** A read that failed (still connecting, server restarting) is tried again; no event may follow. */
const RETRY_MS = [2_000, 5_000, 10_000] as const;

/**
 * One fork read per connected environment, refreshed on that environment's fork events that
 * `accept` lets through. `toValue` returns null to leave an environment out; a server without
 * the route (404) drops out too, while a blip keeps what was last read. `accept` and `toValue`
 * must be module-level, so the subscription does not restart each render.
 */
export function useEnvironmentReads<Body, Value>(
  path: string,
  toValue: (
    body: Body,
    environment: { readonly environmentId: EnvironmentId; readonly label: string },
  ) => Value | null,
  accept: (event: ForkEvent) => boolean,
): ReadonlyArray<Value> {
  const { environments } = useEnvironments();
  const connected = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => ({ id: environment.environmentId, label: environment.label }));
  const connectedKey = JSON.stringify(connected);
  const [values, setValues] = useState<ReadonlyMap<EnvironmentId, Value>>(new Map());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each environment's fork route and refreshes it on that environment's server events
  useEffect(() => {
    const targets = JSON.parse(connectedKey) as ReadonlyArray<{
      readonly id: EnvironmentId;
      readonly label: string;
    }>;
    let cancelled = false;
    const timers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
    // A load asked for mid-read runs once after it, so overlapping reads do not pile up.
    const running = new Map<EnvironmentId, { again: boolean }>();
    const failures = new Map<EnvironmentId, number>();
    const drop = (id: EnvironmentId) =>
      setValues((current) => {
        if (!current.has(id)) return current;
        const next = new Map(current);
        next.delete(id);
        return next;
      });
    const schedule = (target: (typeof targets)[number], delay: number) => {
      if (timers.has(target.id)) return;
      timers.set(
        target.id,
        setTimeout(() => {
          timers.delete(target.id);
          load(target);
        }, delay),
      );
    };
    const load = (target: (typeof targets)[number]) => {
      const inFlight = running.get(target.id);
      if (inFlight) {
        inFlight.again = true;
        return;
      }
      const run = { again: false };
      running.set(target.id, run);
      forkRequest<Body>(target.id, path)
        .then(
          (body) => {
            if (cancelled) return;
            failures.delete(target.id);
            const value = toValue(body, { environmentId: target.id, label: target.label });
            if (value === null) return drop(target.id);
            setValues((current) => new Map(current).set(target.id, value));
          },
          (error: unknown) => {
            if (cancelled) return;
            if (!(error instanceof ForkApiError) || error.status === 0 || error.status >= 500) {
              const failed = failures.get(target.id) ?? 0;
              failures.set(target.id, failed + 1);
              schedule(target, RETRY_MS[failed] ?? 30_000);
              return;
            }
            if (error.status === 404) drop(target.id);
          },
        )
        .finally(() => {
          running.delete(target.id);
          if (run.again && !cancelled) load(target);
        });
    };
    const stops = targets.map((target) => {
      load(target);
      return subscribeToForkEvents(target.id, (event) => {
        if (accept(event)) schedule(target, REFRESH_DEBOUNCE_MS);
      });
    });
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [connectedKey, path, toValue, accept]);

  const connectedIds = new Set(connected.map((target) => target.id));
  return [...values.entries()]
    .filter(([environmentId]) => connectedIds.has(environmentId))
    .map(([, value]) => value);
}
