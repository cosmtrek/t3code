import type { EnvironmentId } from "@t3tools/contracts";

import type { InboxChannelSummary } from "../types";
import { useEnvironmentReads } from "../useEnvironmentReads";
import type { ForkEvent } from "../useForkResource";

export interface EnvironmentInbox {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly channels: ReadonlyArray<InboxChannelSummary>;
  readonly unreadCount: number;
}

const toInbox = (
  overview: { readonly channels: ReadonlyArray<InboxChannelSummary> },
  environment: { readonly environmentId: EnvironmentId; readonly label: string },
): EnvironmentInbox | null =>
  overview.channels.length === 0
    ? null
    : {
        ...environment,
        channels: overview.channels,
        unreadCount: overview.channels.reduce(
          (sum, channel) => sum + (channel.unreadCount ?? 0),
          0,
        ),
      };

// A bot's live status line changes nothing here, and comes once per work-thread item.
const anyEvent = (event: ForkEvent) => event.type !== "bot-activity";
// "synced x ago" is only shown on the inbox page; the sidebar badge ignores sync events.
const notSync = (event: ForkEvent) => anyEvent(event) && event.type !== "sync";

/**
 * Each connected environment's enabled channels. Environments without the inbox (other builds)
 * or without an enabled channel are left out.
 */
export function useInboxOverviews({
  followSync = false,
}: { readonly followSync?: boolean } = {}): ReadonlyArray<EnvironmentInbox> {
  return useEnvironmentReads("/inbox/overview", toInbox, followSync ? anyEvent : notSync);
}
