import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  botAttention,
  botRowStatus,
  botWorkThreadKeys,
  type BotRowStatus,
  type BotSummary,
} from "@t3tools/fork-client/bots";
import { plainPreview } from "@t3tools/fork-client/text";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  BotMessageSquareIcon,
  ChevronDownIcon,
  MessagesSquareIcon,
  PauseIcon,
  PlusIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { useSidebar } from "../../components/ui/sidebar";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { resolveSidebarRowStatus, type SidebarThreadStatus } from "../../components/Sidebar.logic";
import { cn } from "../../lib/utils";
import { useQuietThreadShells } from "../../state/entities";
import { CreateBotDialog, rememberBot } from "../bot/BotsPage";
import { FollowUpStatus } from "../inbox/InboxList";
import { NEEDS_YOU_STATUSES, SIDEBAR_STATUS, StatusLabel } from "../inbox/DelegationPane";
import { agoLabel, lastMessageLine, minuteToMs } from "../inbox/inboxView";
import { useInboxOverviews } from "../inbox/useInboxOverviews";
import { UnreadCount } from "../presentation";
import { useEnvironmentReads } from "../useEnvironmentReads";
import type { ForkEvent } from "../useForkResource";
import { attentionItems, SIDEBAR_INBOX_ROWS, type AttentionItem } from "./sidebarAttention";

export interface EnvironmentBots {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly bots: ReadonlyArray<BotSummary>;
}

const toBots = (
  body: { readonly bots: ReadonlyArray<BotSummary> },
  environment: { readonly environmentId: EnvironmentId; readonly label: string },
): EnvironmentBots => ({ ...environment, bots: body.bots });
const isBotEvent = (event: ForkEvent) => event.type === "bots";

/**
 * Each connected environment's bots (one without bots, another build, is left out), and the
 * sidebar's threads without the bots' own threads: each bot's row stands for its thread.
 */
export function useBotSidebar(threads: ReadonlyArray<EnvironmentThreadShell>): {
  readonly botListings: ReadonlyArray<EnvironmentBots>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
} {
  const botListings = useEnvironmentReads("/bots", toBots, isBotEvent);
  const hidden = botWorkThreadKeys(botListings).join("\n");
  return { botListings, threads: withoutThreads(threads, hidden) };
}

/** Keyed on the joined string, so the compiler's memo holds while the listing only re-reads. */
function withoutThreads(threads: ReadonlyArray<EnvironmentThreadShell>, hidden: string) {
  if (hidden === "") return threads;
  const keys = new Set(hidden.split("\n"));
  return threads.filter((thread) => !keys.has(`${thread.environmentId}:${thread.id}`));
}

type GroupDot = "attention" | "failed" | "unread" | "working";

/** Same colors as a closed project folder's dot. */
const GROUP_DOT_CLASS_NAME: Record<GroupDot, string> = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
};

const GROUP_DOT_LABEL: Record<GroupDot, string> = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", unread",
  working: ", working",
};

const DOT_ORDER: ReadonlyArray<GroupDot> = ["attention", "failed", "unread", "working"];

const BOTS_COLLAPSED_KEY = "t3code:fork-sidebar-bots-collapsed";
const INBOX_COLLAPSED_KEY = "t3code:fork-sidebar-inbox-collapsed";

/** Bots and the inbox's waiting conversations, pinned above the projects. */
export function ForkSidebarGroups({ bots }: { readonly bots: ReadonlyArray<EnvironmentBots> }) {
  return (
    <ul role="presentation" className="mb-2 flex flex-col">
      {bots.length > 0 ? <BotsGroup listings={bots} /> : null}
      <InboxGroup />
    </ul>
  );
}

function useCloseMobileSidebar() {
  const { isMobile, setOpenMobile } = useSidebar();
  return () => {
    if (isMobile) setOpenMobile(false);
  };
}

function GroupHeader({
  icon,
  label,
  collapsed,
  dot,
  count,
  onOpen,
  onToggle,
  action,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly collapsed: boolean;
  /** While collapsed, the most pressing hidden status and how many rows are hidden. */
  readonly dot: GroupDot | null;
  readonly count: number;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
  readonly action?: ReactNode;
}) {
  return (
    <li className="group/fork-group relative mt-2 flex list-none items-center first:mt-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-(--control-radius) ps-(--sidebar-row-content-inset) pe-8 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-sidebar-foreground/90 [&_svg]:size-4">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
          {label}
        </span>
        {collapsed && dot ? (
          <span className={cn("size-1.5 shrink-0 rounded-full", GROUP_DOT_CLASS_NAME[dot])}>
            <span className="sr-only">{GROUP_DOT_LABEL[dot]}</span>
          </span>
        ) : null}
        {collapsed && count > 0 ? (
          <span
            className={cn(
              "shrink-0 text-xs tabular-nums text-sidebar-muted-foreground",
              action &&
                "group-hover/fork-group:invisible group-focus-within/fork-group:invisible pointer-coarse:invisible",
            )}
          >
            {count}
          </span>
        ) : null}
      </button>
      <span className="absolute inset-y-0 right-7 flex items-center opacity-0 focus-within:opacity-100 group-hover/fork-group:opacity-100 pointer-coarse:opacity-100">
        {action}
      </span>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Show ${label}` : `Hide ${label}`}
        onClick={onToggle}
        className="absolute right-1"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 transition-transform", collapsed && "-rotate-90")}
        />
      </Button>
    </li>
  );
}

/** A two-line row lined up with folder rows: name and one status, then a preview. */
function GroupRow({
  title,
  status,
  preview,
  active = false,
  onClick,
}: {
  readonly title: string;
  readonly status: ReactNode;
  readonly preview: ReactNode;
  readonly active?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <li className="list-none">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={cn(
          "group/sidebar-row flex w-full cursor-pointer flex-col justify-center rounded-md px-2.5 py-1.5 ps-9 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <span className="flex h-6 min-w-0 items-center gap-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {title}
          </span>
          <span className="flex shrink-0 items-center tabular-nums text-xs text-secondary-label">
            {status}
          </span>
        </span>
        {preview === "" || preview === null ? null : (
          <span className="mt-0.5 min-w-0 truncate text-xs text-secondary-label">{preview}</span>
        )}
      </button>
    </li>
  );
}

function BotsGroup({ listings }: { readonly listings: ReadonlyArray<EnvironmentBots> }) {
  const navigate = useNavigate();
  const closeMobile = useCloseMobileSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = useSearch({ strict: false }) as { environmentId?: string; botId?: string };
  const now = minuteToMs(useNowMinute());
  const [collapsed, setCollapsed] = useLocalStorage(BOTS_COLLAPSED_KEY, false, Schema.Boolean);
  const [creatingIn, setCreatingIn] = useState<EnvironmentId | null>(null);
  const threadStatus = useThreadStatuses();
  const named = listings.length > 1;
  const rows = listings.flatMap((listing) =>
    listing.bots.map((bot) => ({
      listing,
      bot,
      status: botRowStatus(
        bot,
        blockedStatus(
          bot.workThreadId === null
            ? null
            : (threadStatus.get(`${listing.environmentId}:${bot.workThreadId}`) ?? null),
        ),
      ),
    })),
  );
  const open = (environmentId: EnvironmentId | undefined, botId: string | undefined) => {
    closeMobile();
    if (environmentId && botId) rememberBot(environmentId, botId);
    void navigate({
      to: "/bots",
      search: environmentId && botId ? { environmentId, botId } : {},
    });
  };
  const newBot =
    listings.length === 1 ? (
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="New bot"
        onClick={() => setCreatingIn(listings[0]!.environmentId)}
      >
        <PlusIcon aria-hidden />
      </Button>
    ) : (
      <Menu>
        <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label="New bot" />}>
          <PlusIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {listings.map((listing) => (
            <MenuItem
              key={listing.environmentId}
              onClick={() => setCreatingIn(listing.environmentId)}
            >
              New bot on {listing.label}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    );

  return (
    <>
      <GroupHeader
        icon={<BotMessageSquareIcon />}
        label="Bots"
        collapsed={collapsed}
        dot={mostPressing(rows.map(({ status }) => botAttention(status)))}
        count={rows.length}
        onOpen={() => open(undefined, undefined)}
        onToggle={() => setCollapsed((value) => !value)}
        action={newBot}
      />
      {collapsed
        ? null
        : rows.map(({ listing, bot, status }) => {
            const preview = bot.lastMessage
              ? plainPreview(bot.lastMessage.text)
              : "No messages yet";
            return (
              <GroupRow
                key={`${listing.environmentId}:${bot.id}`}
                title={bot.name}
                status={<BotStatus status={status} now={now} />}
                preview={named ? `${listing.label} · ${preview}` : preview}
                active={
                  pathname === "/bots" &&
                  search.environmentId === listing.environmentId &&
                  search.botId === bot.id
                }
                onClick={() => open(listing.environmentId, bot.id)}
              />
            );
          })}
      {creatingIn === null ? null : (
        <CreateBotDialog
          environmentId={creatingIn}
          onClose={() => setCreatingIn(null)}
          onCreated={(botId) => {
            const environmentId = creatingIn;
            setCreatingIn(null);
            open(environmentId, botId);
          }}
        />
      )}
    </>
  );
}

/** Each thread's sidebar status, keyed `environmentId:threadId`. */
function useThreadStatuses(): ReadonlyMap<string, SidebarThreadStatus> {
  const shells = useQuietThreadShells();
  return new Map(
    shells.map((shell) => [`${shell.environmentId}:${shell.id}`, resolveSidebarRowStatus(shell)]),
  );
}

const mostPressing = (dots: ReadonlyArray<GroupDot | null>): GroupDot | null =>
  DOT_ORDER.find((dot) => dots.includes(dot)) ?? null;

/** The work thread's status counts only when it waits on the user: the row stands for it. */
const blockedStatus = (thread: SidebarThreadStatus | null) =>
  thread !== null && thread !== "ready" && NEEDS_YOU_STATUSES.has(thread) ? thread : null;

function BotStatus({
  status,
  now,
}: {
  readonly status: BotRowStatus<Exclude<SidebarThreadStatus, "ready">>;
  readonly now: number;
}) {
  switch (status.kind) {
    case "question":
      return <StatusLabel {...SIDEBAR_STATUS.input} />;
    case "blocked":
      return <StatusLabel {...SIDEBAR_STATUS[status.status]} />;
    case "unread":
      return <UnreadCount count={status.count} />;
    case "working":
      return <StatusLabel {...SIDEBAR_STATUS.working} />;
    case "paused":
      return <StatusLabel icon={PauseIcon} label="Paused" className="text-muted-foreground" />;
    case "age":
      return <span>{agoLabel(status.at, now)}</span>;
    case "none":
      return null;
  }
}

/** Each environment's threads waiting on the user, for follow-ups whose thread is blocked. */
function useBlockedThreads(): ReadonlyMap<EnvironmentId, ReadonlySet<string>> {
  const shells = useQuietThreadShells();
  const blocked = new Map<EnvironmentId, Set<string>>();
  for (const shell of shells) {
    if (!NEEDS_YOU_STATUSES.has(resolveSidebarRowStatus(shell))) continue;
    const set = blocked.get(shell.environmentId) ?? new Set<string>();
    set.add(shell.id);
    blocked.set(shell.environmentId, set);
  }
  return blocked;
}

function InboxGroup() {
  const navigate = useNavigate();
  const closeMobile = useCloseMobileSidebar();
  const inboxes = useInboxOverviews();
  const blocked = useBlockedThreads();
  const now = minuteToMs(useNowMinute());
  const [collapsed, setCollapsed] = useLocalStorage(INBOX_COLLAPSED_KEY, false, Schema.Boolean);
  if (inboxes.length === 0) return null;
  const items = attentionItems(inboxes, blocked);
  const shown = items.slice(0, SIDEBAR_INBOX_ROWS);
  const more = items.length - shown.length;
  const open = (item: AttentionItem | null) => {
    closeMobile();
    void navigate({
      to: "/inbox",
      search: item
        ? {
            environmentId: item.environmentId,
            channelId: item.channelId,
            conversationId: item.conversation.id,
          }
        : {},
    });
  };

  return (
    <>
      <GroupHeader
        icon={<MessagesSquareIcon />}
        label="Inbox"
        collapsed={collapsed}
        dot={items.length > 0 ? "attention" : null}
        count={items.length}
        onOpen={() => open(null)}
        onToggle={() => setCollapsed((value) => !value)}
      />
      {collapsed ? null : (
        <>
          {shown.map((item) => (
            <GroupRow
              key={`${item.environmentId}:${item.channelId}:${item.conversation.id}`}
              title={item.conversation.name}
              status={
                item.followUp ? (
                  <FollowUpStatus
                    environmentId={item.environmentId}
                    delegation={item.followUp}
                    onlyNeedsYou
                  />
                ) : item.conversation.unread ? (
                  <UnreadCount
                    count={Math.max(item.conversation.unreadCount ?? 1, 1)}
                    muted={item.conversation.muted}
                  />
                ) : (
                  agoLabel(item.conversation.lastActivityAt, now)
                )
              }
              preview={
                item.conversation.mentioned ? (
                  <>
                    <span className="font-medium text-primary">[@you] </span>
                    {lastMessageLine(item.conversation)}
                  </>
                ) : (
                  lastMessageLine(item.conversation)
                )
              }
              onClick={() => open(item)}
            />
          ))}
          {more > 0 ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() => open(null)}
                className="flex h-7 w-full cursor-pointer items-center rounded-md px-2.5 ps-9 text-left text-xs text-secondary-label outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {more} more
              </button>
            </li>
          ) : null}
        </>
      )}
    </>
  );
}
