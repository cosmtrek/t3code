import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../fork/bot/BotsPage";

export const Route = createFileRoute("/_chat/bots")({
  component: BotsPage,
});
