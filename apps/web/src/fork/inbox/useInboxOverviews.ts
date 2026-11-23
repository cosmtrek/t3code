import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import type { InboxChannelSummary } from "../types";
import { subscribeToForkEvents } from "../useForkResource";

export interface EnvironmentInbox {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly channels: ReadonlyArray<InboxChannelSummary>;
  readonly unreadCount: number;
}

const REFRESH_DEBOUNCE_MS = 1_000;
/** A read that failed (still connecting, server restarting) is tried again; no event may follow. */
const RETRY_MS = [2_000, 5_000, 10_000] as const;

/**
 * Each connected environment's enabled channels. Environments without the inbox (other builds)
 * or without an enabled channel are left out.
 */
export function useInboxOverviews(
  // "synced x ago" is only shown on the inbox page; the sidebar badge ignores sync events.
  { followSync = false }: { readonly followSync?: boolean } = {},
): ReadonlyArray<EnvironmentInbox> {
  const { environments } = useEnvironments();
  const connected = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => ({ id: environment.environmentId, label: environment.label }));
  const connectedKey = JSON.stringify(connected);
  const [overviews, setOverviews] = useState<ReadonlyMap<EnvironmentId, EnvironmentInbox>>(
    new Map(),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads each environment's inbox overview and refreshes it on that environment's server events
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
      forkRequest<{ channels: ReadonlyArray<InboxChannelSummary> }>(target.id, "/inbox/overview")
        .then(
          (overview) => {
            if (cancelled) return;
            failures.delete(target.id);
            setOverviews((current) => {
              const next = new Map(current);
              if (overview.channels.length === 0) next.delete(target.id);
              else {
                next.set(target.id, {
                  environmentId: target.id,
                  label: target.label,
                  channels: overview.channels,
                  unreadCount: overview.channels.reduce(
                    (sum, channel) => sum + (channel.unreadCount ?? 0),
                    0,
                  ),
                });
              }
              return next;
            });
          },
          (error: unknown) => {
            if (cancelled) return;
            // Only a server without the inbox drops out; a blip keeps what was last read.
            if (!(error instanceof ForkApiError) || error.status === 0 || error.status >= 500) {
              const failed = failures.get(target.id) ?? 0;
              failures.set(target.id, failed + 1);
              schedule(target, RETRY_MS[failed] ?? 30_000);
              return;
            }
            if (error.status !== 404) return;
            setOverviews((current) => {
              if (!current.has(target.id)) return current;
              const next = new Map(current);
              next.delete(target.id);
              return next;
            });
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
        if (event.type === "sync" && !followSync) return;
        schedule(target, REFRESH_DEBOUNCE_MS);
      });
    });
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [connectedKey, followSync]);

  const connectedIds = new Set(connected.map((target) => target.id));
  return [...overviews.values()].filter((overview) => connectedIds.has(overview.environmentId));
}
