import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { InboxPage, type InboxSearch } from "../fork/inbox/InboxPage";

const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 500) : undefined);

export const Route = createFileRoute("/_chat/inbox")({
  validateSearch: (raw: Record<string, unknown>): InboxSearch => {
    const environmentId = text(raw.environmentId);
    const channelId = text(raw.channelId);
    const conversationId = text(raw.conversationId);
    return environmentId && channelId && conversationId
      ? { environmentId: EnvironmentId.make(environmentId), channelId, conversationId }
      : {};
  },
  component: InboxPage,
});
