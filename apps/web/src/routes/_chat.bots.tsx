import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { BotsPage, type BotsSearch } from "../fork/bot/BotsPage";

const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 200) : undefined);

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (raw: Record<string, unknown>): BotsSearch => {
    const environmentId = text(raw.environmentId);
    const botId = text(raw.botId);
    return environmentId && botId
      ? { environmentId: EnvironmentId.make(environmentId), botId }
      : {};
  },
  component: BotsPage,
});
