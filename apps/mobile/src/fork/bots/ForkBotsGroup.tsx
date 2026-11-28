import { useAtomValue } from "@effect/atom-react";
import { botRowStatus, type BotRowStatus, type BotSummary } from "@t3tools/fork-client/bots";
import { plainPreview } from "@t3tools/fork-client/text";
import { useNavigationState } from "@react-navigation/native";
import { useMessages } from "gt-react-native";
import { useSyncExternalStore } from "react";
import { View } from "react-native";

import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { usePaneRole } from "../../components/ui/Pane";
import { RowPressable } from "../../components/ui/RowPressable";
import { useSelectWorkspaceDetail } from "../../features/layout/workspace/useSelectWorkspaceDetail";
import {
  STATUS_LABEL_BY_STATUS,
  ThreadListV2Section,
} from "../../features/threads/thread-list-v2-items";
import {
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  getThreadListV2RowAppearance,
  selectedThreadRowColors,
} from "../../features/threads/thread-list-v2-row-appearance";
import {
  resolveThreadListV2RowStatus,
  type ThreadListV2Status,
} from "../../features/threads/threadListV2";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
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

/**
 * The bots of every connected environment, pinned above the thread list as on desktop. It hides
 * while the user searches the list, and is absent when no environment has a bot.
 */
export function ForkBotsGroup(props: { readonly searching: boolean }) {
  const listings = useBotListings();
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
  return (
    <View>
      <ThreadListV2Section
        label="Bots"
        pane={pane}
        disclosure={{
          expanded: !collapsed,
          onToggle: toggle,
          accessibilityLabel: rows.length === 1 ? "1 bot" : `${rows.length} bots`,
          accessibilityHint: collapsed ? "Expands the bots." : "Collapses the bots.",
        }}
      />
      {collapsed
        ? null
        : rows.map(({ listing, bot, status }, index) => (
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
    <View>
      <View className="flex-row items-center gap-2.5">
        <View className="size-5 items-center justify-center rounded-full bg-subtle">
          <Text className={cn("text-[11px] font-t3-bold", muted)}>
            {bot.name.slice(0, 1).toUpperCase()}
          </Text>
        </View>
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
      <Text
        className={cn(
          "mt-1 pl-[30px] text-sm",
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
        {props.environmentLabel ? `${props.environmentLabel} · ${preview}` : preview}
      </Text>
    </View>
  );

  return (
    <View
      className={status.kind === "paused" ? "opacity-60" : undefined}
      style={appearance.swipeContainerStyle}
    >
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={[bot.name, props.environmentLabel, statusText(status, m), preview]
          .filter(Boolean)
          .join(", ")}
        accessibilityState={{ selected }}
        className={appearance.className}
        interactionClassName={appearance.interactionClassName}
        interactionOpacity={appearance.interactionOpacity}
        style={appearance.cardStyle}
        onPress={() =>
          selectDetail({
            name: "Bot",
            params: { environmentId: String(props.listing.environmentId), botId: bot.id },
          })
        }
      >
        {sidebarPane ? (
          content
        ) : (
          <View>
            <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{content}</View>
            {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider ? (
              <View className="ml-5 h-px bg-border-subtle" />
            ) : null}
          </View>
        )}
      </RowPressable>
    </View>
  );
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
