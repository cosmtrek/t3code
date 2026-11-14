import { createFileRoute } from "@tanstack/react-router";

import { ChannelsSettingsPanel } from "../fork/channels/ChannelsSettingsPanel";

export const Route = createFileRoute("/_chat/settings/channels")({
  component: ChannelsSettingsPanel,
});
