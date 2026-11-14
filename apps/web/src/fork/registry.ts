/**
 * Everything this fork adds to upstream's settings tables and sidebar, so each upstream file
 * carries a one-line spread. The sidebar entry lives in inbox/ForkSidebarItems.tsx, apart, so
 * the settings tables do not pull in React views. See "Inbox seams" in FORK.md.
 */
import { MessagesSquareIcon } from "lucide-react";
import type { ComponentType } from "react";

import type {
  SettingsSearchItem,
  SettingsSearchScope,
} from "../components/settings/settingsSearch";

export type ForkSettingsPath = "/settings/channels";

export const FORK_SETTINGS_LABELS: Readonly<Record<ForkSettingsPath, string>> = {
  "/settings/channels": "Channels",
};

export const FORK_SETTINGS_NAV_PATHS: ReadonlyArray<ForkSettingsPath> = ["/settings/channels"];

export const FORK_SETTINGS_ICONS: Readonly<
  Record<ForkSettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/channels": MessagesSquareIcon,
};

/** Channels shows every environment read-only under "all", so it needs no particular scope. */
export const FORK_SETTINGS_CATEGORY_SCOPES: Readonly<
  Record<ForkSettingsPath, SettingsSearchScope | null>
> = {
  "/settings/channels": null,
};

export const FORK_SETTINGS_SEARCH_ITEMS = [
  {
    id: "channels",
    title: "Channels",
    to: "/settings/channels",
    searchTerms: ["inbox messages chat im adapter channel token delegate"],
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;
