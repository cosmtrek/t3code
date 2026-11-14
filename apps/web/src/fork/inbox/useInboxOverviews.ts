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
  readonly pendingCount: number;
}

const REFRESH_DEBOUNCE_MS = 1_000;

/**
 * Each connected environment's enabled channels. Environments without the inbox (other builds)
 * or without an enabled channel are left out.
 */
export function useInboxOverviews(): ReadonlyArray<EnvironmentInbox> {
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
    const load = (target: (typeof targets)[number]) => {
      forkRequest<{ channels: ReadonlyArray<InboxChannelSummary> }>(
        target.id,
        "/inbox/overview",
      ).then(
        (overview) => {
          if (cancelled) return;
          setOverviews((current) => {
            const next = new Map(current);
            if (overview.channels.length === 0) next.delete(target.id);
            else {
              next.set(target.id, {
                environmentId: target.id,
                label: target.label,
                channels: overview.channels,
                pendingCount: overview.channels.reduce(
                  (sum, channel) => sum + (channel.pendingCount ?? 0),
                  0,
                ),
              });
            }
            return next;
          });
        },
        (error: unknown) => {
          // Only a server without the inbox drops out; a blip keeps what was last read.
          if (cancelled || !(error instanceof ForkApiError) || error.status !== 404) return;
          setOverviews((current) => {
            if (!current.has(target.id)) return current;
            const next = new Map(current);
            next.delete(target.id);
            return next;
          });
        },
      );
    };
    const stops = targets.map((target) => {
      load(target);
      return subscribeToForkEvents(target.id, () => {
        if (timers.has(target.id)) return;
        timers.set(
          target.id,
          setTimeout(() => {
            timers.delete(target.id);
            load(target);
          }, REFRESH_DEBOUNCE_MS),
        );
      });
    });
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [connectedKey]);

  const connectedIds = new Set(connected.map((target) => target.id));
  return [...overviews.values()].filter((overview) => connectedIds.has(overview.environmentId));
}
