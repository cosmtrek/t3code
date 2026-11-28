import { useAtomValue } from "@effect/atom-react";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import type { EnvironmentId } from "@t3tools/contracts";
import { botRowStatus, type BotRowStatus, type BotSummary } from "@t3tools/fork-client/bots";
import { plainPreview } from "@t3tools/fork-client/text";
import { useNavigationState } from "@react-navigation/native";
import { useMessages } from "gt-react-native";
import { useSyncExternalStore } from "react";
import { Platform, Pressable, View, type ViewStyle } from "react-native";

import { ProviderInstanceIcon } from "../../components/ProviderIcon";
import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { usePaneRole } from "../../components/ui/Pane";
import { RowPressable } from "../../components/ui/RowPressable";
import { useSelectWorkspaceDetail } from "../../features/layout/workspace/useSelectWorkspaceDetail";
import { STATUS_LABEL_BY_STATUS } from "../../features/threads/thread-list-v2-items";
import {
  THREAD_LIST_V2_ROW_DIVIDERS,
  getThreadListV2RowAppearance,
  selectedThreadRowColors,
} from "../../features/threads/thread-list-v2-row-appearance";
import {
  resolveThreadListV2RowStatus,
  type ThreadListV2Status,
} from "../../features/threads/threadListV2";
import { cn } from "../../lib/cn";
import { MOBILE_SHAPE } from "../../lib/designTokens";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentServerConfig } from "../../state/entities";
import { steadyNavigationThreadShellsAtom } from "../../state/threads";
import {
  readForkPreference,
  subscribeForkPreference,
  writeForkPreference,
} from "../forkPreferences";
import { useBotListings, type BotListing } from "./botListings";

/** The work thread's statuses that wait on the user; any other shows the bot's own status. */
const BLOCKED: ReadonlySet<ThreadListV2Status> = new Set([
  "approval",
  "input",
  "request",
  "failed",
  "limited",
]);

const COLLAPSED_KEY = "botsGroupCollapsed";
const subscribeCollapsed = (listener: () => void) =>
  subscribeForkPreference(COLLAPSED_KEY, listener);
const readCollapsed = () => readForkPreference(COLLAPSED_KEY) === true;

const CARD_RADIUS = Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios;
/** Android rows are rounded blocks inside the card; iOS rows run edge to edge with dividers. */
const ROW_RADIUS = Platform.OS === "android" ? 20 : 0;

/**
 * The bots of every connected environment, pinned above the thread list in a card of their own,
 * so the threads below do not read as part of the group. It follows the list's environment
 * filter (null shows every environment), hides while the user searches, and is absent when no
 * environment in view has a bot.
 */
export function ForkBotsGroup(props: {
  readonly searching: boolean;
  readonly environmentIds: ReadonlyArray<EnvironmentId> | null;
}) {
  const allListings = useBotListings();
  const listings =
    props.environmentIds === null
      ? allListings
      : allListings.filter((listing) => props.environmentIds?.includes(listing.environmentId));
  const pane = usePaneRole() === "sidebar" ? "sidebar" : "screen";
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed);
  const blocked = useBlockedWorkThreads(listings);
  const selected = useNavigationState((state) => {
    const route = state?.routes[state.index];
    if (route?.name !== "Bot") return null;
    const params = route.params as { environmentId?: string; botId?: string } | undefined;
    return `${params?.environmentId}:${params?.botId}`;
  });
  if (props.searching || listings.length === 0) return null;
  const rows = listings.flatMap((listing) =>
    listing.bots.map((bot) => ({
      listing,
      bot,
      status: botRowStatus(
        bot,
        bot.workThreadId === null
          ? null
          : (blocked.get(`${listing.environmentId}:${bot.workThreadId}`) ?? null),
      ),
    })),
  );
  const toggle = () => {
    writeForkPreference(COLLAPSED_KEY, !readCollapsed());
  };
  const sidebarPane = pane === "sidebar";
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={rows.length === 1 ? "Bots, 1 bot" : `Bots, ${rows.length} bots`}
        accessibilityHint={collapsed ? "Expands the bots." : "Collapses the bots."}
        accessibilityState={{ expanded: !collapsed }}
        className={cn("mb-1.5 mt-4 flex-row items-center gap-1.5", sidebarPane ? "px-3" : "px-5")}
        hitSlop={8}
        onPress={toggle}
      >
        <Text
          className={cn(
            "text-xs font-t3-medium",
            sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-tertiary",
          )}
        >
          Bots
        </Text>
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
          }
          type="monochrome"
          weight="semibold"
          style={collapsed ? { transform: [{ rotate: "-90deg" }] } : undefined}
        />
      </Pressable>
      {collapsed ? null : (
        <View
          className={cn(
            "mb-3 overflow-hidden border-continuous bg-grouped-card",
            sidebarPane ? "mx-2" : "mx-3",
            Platform.OS === "android" && "p-1",
          )}
          style={{ borderRadius: CARD_RADIUS }}
        >
          {rows.map(({ listing, bot, status }, index) => (
            <BotRow
              key={`${listing.environmentId}:${bot.id}`}
              listing={listing}
              environmentLabel={listings.length > 1 ? listing.label : null}
              bot={bot}
              status={status}
              pane={pane}
              selected={selected === `${listing.environmentId}:${bot.id}`}
              showTrailingDivider={index < rows.length - 1}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Each bot work thread that waits on the user, by `environmentId:threadId`. */
function useBlockedWorkThreads(
  listings: ReadonlyArray<BotListing>,
): ReadonlyMap<string, ThreadListV2Status> {
  const keys = new Set(
    listings.flatMap((listing) =>
      listing.bots.flatMap((bot) =>
        bot.workThreadId === null ? [] : [`${listing.environmentId}:${bot.workThreadId}`],
      ),
    ),
  );
  // A string, so the list streaming past does not re-render the group unless one of these changes.
  const encoded = useAtomValue(steadyNavigationThreadShellsAtom, (threads) =>
    threads
      .flatMap((thread) => {
        const key = `${thread.environmentId}:${thread.id}`;
        if (!keys.has(key)) return [];
        const status = resolveThreadListV2RowStatus(thread);
        return BLOCKED.has(status) ? [`${key}=${status}`] : [];
      })
      .join("\n"),
  );
  return new Map(
    encoded === ""
      ? []
      : encoded.split("\n").map((entry) => {
          const at = entry.lastIndexOf("=");
          return [entry.slice(0, at), entry.slice(at + 1) as ThreadListV2Status] as const;
        }),
  );
}

function BotRow(props: {
  readonly listing: BotListing;
  readonly environmentLabel: string | null;
  readonly bot: BotSummary;
  readonly status: BotRowStatus<ThreadListV2Status>;
  readonly pane: "screen" | "sidebar";
  readonly selected: boolean;
  readonly showTrailingDivider: boolean;
}) {
  const m = useMessages();
  const theme = useUniwindTheme();
  const selectDetail = useSelectWorkspaceDetail();
  const sidebarPane = props.pane === "sidebar";
  const appearance = getThreadListV2RowAppearance(theme, sidebarPane, props.selected);
  const { bot, status, selected } = props;
  const provider = useBotProvider(props.listing.environmentId, bot);
  const surfaceColor = selected ? theme["--color-thread-selected"] : theme["--color-grouped-card"];
  const rowStyle: ViewStyle = { backgroundColor: surfaceColor, borderRadius: ROW_RADIUS };
  const recede = !selected && status.kind === "working";
  const preview = bot.lastMessage
    ? `${bot.lastMessage.role === "user" ? "You: " : ""}${plainPreview(bot.lastMessage.text)}`
    : "No messages yet";
  const foreground = selected
    ? selectedThreadRowColors.foregroundClassName
    : appearance.foregroundClassName;
  const muted = selected
    ? selectedThreadRowColors.mutedForegroundClassName
    : appearance.mutedForegroundClassName;

  const content = (
    <View className="flex-row items-center gap-3">
      <View className="size-9 items-center justify-center rounded-full bg-primary/15">
        <Text
          className={cn(
            "text-sm font-t3-bold",
            selected ? selectedThreadRowColors.foregroundClassName : "text-primary-text",
          )}
        >
          {bot.name.slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text
            className={cn(
              "flex-1 text-base",
              !recede && "font-t3-medium",
              foreground,
              recede && "opacity-55",
            )}
            numberOfLines={1}
          >
            {bot.name}
          </Text>
          <BotStatus
            status={status}
            selected={selected}
            tertiary={appearance.tertiaryForegroundClassName}
          />
        </View>
        <View className="mt-0.5 flex-row items-center gap-2">
          <Text
            className={cn(
              "flex-1 text-sm",
              bot.lastMessage === null
                ? muted
                : bot.lastMessage.role === "error"
                  ? "text-danger-foreground"
                  : status.kind === "question" || status.kind === "unread"
                    ? foreground
                    : muted,
              bot.lastMessage === null && "italic",
            )}
            numberOfLines={1}
          >
            {preview}
          </Text>
          {provider ? (
            <ProviderInstanceIcon
              iconUrl={provider.iconUrl}
              provider={provider.driverKind}
              size={14}
              displayName={provider.displayName}
              accentColor={provider.accentColor}
              showBadge={provider.showBadge}
              surfaceColor={surfaceColor}
            />
          ) : null}
        </View>
      </View>
    </View>
  );

  return (
    <View
      className={cn("overflow-hidden", status.kind === "paused" && "opacity-60")}
      style={{ borderRadius: ROW_RADIUS }}
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[bot.name, props.environmentLabel, statusText(status, m), preview]
          .filter(Boolean)
          .join(", ")}
        accessibilityState={{ selected }}
        interactionClassName={appearance.interactionClassName}
        interactionOpacity={appearance.interactionOpacity}
        style={rowStyle}
        onPress={() =>
          selectDetail({
            name: "Bot",
            params: { environmentId: String(props.listing.environmentId), botId: bot.id },
          })
        }
      >
        <View className={Platform.OS === "android" ? "px-3 py-2.5" : "px-4 py-2.5"}>{content}</View>
        {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider ? (
          <View className="ml-16 h-px bg-border-subtle" />
        ) : null}
      </RowPressable>
    </View>
  );
}

/** The bot's provider instance, shown beside its preview as on desktop. */
function useBotProvider(environmentId: EnvironmentId, bot: BotSummary) {
  const providers = useEnvironmentServerConfig(environmentId)?.providers ?? [];
  const snapshot = providers.find(
    (candidate) => candidate.instanceId === bot.modelSelection.instanceId,
  );
  if (!snapshot) return null;
  const entry = {
    driverKind: snapshot.driver,
    displayName: resolveProviderInstanceDisplayName(snapshot),
    accentColor: normalizeProviderAccentColor(snapshot.accentColor),
    iconUrl: snapshot.iconUrl,
  };
  return {
    ...entry,
    showBadge: shouldShowInstanceBadge(
      { ...entry, enabled: snapshot.enabled },
      providers.map((candidate) => ({ driverKind: candidate.driver, enabled: candidate.enabled })),
    ),
  };
}

/** The status's words; Working, the blocked statuses and Input are the thread list's own. */
function statusText(
  status: BotRowStatus<ThreadListV2Status>,
  m: ReturnType<typeof useMessages>,
): string | null {
  switch (status.kind) {
    case "question":
    case "blocked": {
      const label =
        STATUS_LABEL_BY_STATUS[status.kind === "question" ? "input" : status.status]?.label;
      return label ? m(label) : null;
    }
    case "unread":
      return `${status.count} new`;
    case "working":
      return "Working";
    case "paused":
      return "Paused";
    default:
      return null;
  }
}

function BotStatus(props: {
  readonly status: BotRowStatus<ThreadListV2Status>;
  readonly selected: boolean;
  readonly tertiary: string;
}) {
  const m = useMessages();
  const { status, selected } = props;
  if (status.kind === "age") {
    return (
      <Text
        className={cn(
          "text-xs tabular-nums",
          selected ? selectedThreadRowColors.foregroundClassName : props.tertiary,
        )}
      >
        <RelativeTime timestamp={status.at} />
      </Text>
    );
  }
  if (status.kind === "none") return null;
  if (status.kind === "unread" || status.kind === "paused") {
    return (
      <Text
        className={cn(
          "text-xs font-t3-bold",
          selected
            ? selectedThreadRowColors.foregroundClassName
            : status.kind === "unread"
              ? "text-primary-text"
              : "text-foreground-muted",
        )}
      >
        {statusText(status, m)}
      </Text>
    );
  }
  const entry =
    STATUS_LABEL_BY_STATUS[
      status.kind === "question" ? "input" : status.kind === "blocked" ? status.status : "working"
    ];
  if (!entry) return null;
  return (
    <View className="flex-row items-center gap-1">
      <SymbolView
        name={entry.icon}
        size={13}
        tintColorClassName={
          selected ? selectedThreadRowColors.iconTintClassName : entry.iconTintClassName
        }
        type="monochrome"
        weight="semibold"
      />
      <Text
        className={cn(
          "text-xs font-t3-bold",
          selected ? selectedThreadRowColors.foregroundClassName : entry.className,
        )}
      >
        {statusText(status, m)}
      </Text>
    </View>
  );
}
