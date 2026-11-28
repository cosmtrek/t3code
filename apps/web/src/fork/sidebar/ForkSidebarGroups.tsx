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
  ArrowUpRightIcon,
  BotMessageSquareIcon,
  ChevronDownIcon,
  MessagesSquareIcon,
  PauseIcon,
  PlusIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { EnvironmentMachineIcon } from "../../components/EnvironmentMachineIcon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../../components/ThreadHoverCard";
import { ProviderInstanceIcon } from "../../components/chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../../components/chat/providerIconUtils";
import { Tooltip, TooltipTrigger } from "../../components/ui/tooltip";
import { deriveProviderInstanceEntries, shouldShowInstanceBadge } from "../../providerInstances";
import { useEnvironmentMachines, useEnvironmentProviders } from "../../state/environments";
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

/**
 * Bots and the inbox's waiting conversations, pinned above the projects. Both belong to an
 * environment, so a project scope narrows them to its projects' environments.
 */
export function ForkSidebarGroups({
  bots,
  projectScope,
}: {
  readonly bots: ReadonlyArray<EnvironmentBots>;
  readonly projectScope: ReadonlyArray<{
    readonly memberProjectRefs: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
  }>;
}) {
  const inScope = scopeFilter(projectScope);
  const shownBots = bots.filter((listing) => inScope(listing.environmentId));
  return (
    <ul role="presentation" className="mb-2 flex flex-col">
      {shownBots.length > 0 ? <BotsGroup listings={shownBots} /> : null}
      <InboxGroup inScope={inScope} />
    </ul>
  );
}

function scopeFilter(
  projectScope: ReadonlyArray<{
    readonly memberProjectRefs: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
  }>,
): (environmentId: EnvironmentId) => boolean {
  if (projectScope.length === 0) return () => true;
  const environments = new Set(
    projectScope.flatMap((project) => project.memberProjectRefs.map((ref) => ref.environmentId)),
  );
  return (environmentId) => environments.has(environmentId);
}

/** The group's rows on a raised panel, so the threads below do not read as part of it. */
function GroupPanel({ children }: { readonly children: ReactNode }) {
  return (
    <li className="mt-0.5 list-none">
      <ul role="presentation" className="flex flex-col rounded-lg bg-sidebar-control-surface p-0.5">
        {children}
      </ul>
    </li>
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
  onToggle,
  action,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly collapsed: boolean;
  /** While collapsed, the most pressing hidden status and how many rows are hidden. */
  readonly dot: GroupDot | null;
  readonly count: number;
  readonly onToggle: () => void;
  readonly action?: ReactNode;
}) {
  return (
    <li className="group/fork-group relative mt-2 flex list-none items-center first:mt-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      <span className="absolute inset-y-0 right-6 flex items-center opacity-0 group-focus-within/fork-group:opacity-100 group-hover/fork-group:opacity-100 pointer-coarse:opacity-100">
        {action}
      </span>
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
  botStatus,
  empty = false,
  error = false,
  provider,
  tooltip,
}: {
  readonly botStatus?: BotRowStatus<string>;
  readonly empty?: boolean;
  readonly error?: boolean;
  readonly provider?: ReactNode;
  readonly tooltip?: ReactNode;
  readonly title: string;
  readonly status: ReactNode;
  readonly preview: ReactNode;
  readonly active?: boolean;
  readonly onClick: () => void;
}) {
  const row = (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "group/sidebar-row flex w-full cursor-pointer flex-col justify-center rounded-md px-2.5 py-1.5 ps-9 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        botStatus?.kind === "paused" && "opacity-60",
        active
          ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
          : "text-sidebar-foreground hover:bg-sidebar-row-hover",
      )}
    >
      <span className="flex h-6 min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm font-medium",
            botStatus?.kind === "working" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </span>
        <span className="flex shrink-0 items-center tabular-nums text-xs text-secondary-label">
          {status}
        </span>
      </span>
      {!botStatus && (preview === "" || preview === null) ? null : (
        <span className="mt-0.5 flex w-full min-w-0 items-center gap-2 text-xs">
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              empty
                ? "text-secondary-label italic"
                : error
                  ? "text-error-foreground"
                  : botStatus?.kind === "question" || botStatus?.kind === "unread"
                    ? "text-foreground/85"
                    : "text-secondary-label",
            )}
          >
            {preview}
          </span>
          {provider}
        </span>
      )}
    </button>
  );
  return (
    <li className="list-none">
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger render={row} />
          {tooltip}
        </Tooltip>
      ) : (
        row
      )}
    </li>
  );
}

function BotRow({
  listing,
  bot,
  status,
  now,
  active,
  onClick,
}: {
  readonly listing: EnvironmentBots;
  readonly bot: BotSummary;
  readonly status: BotRowStatus<Exclude<SidebarThreadStatus, "ready">>;
  readonly now: number;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  const providers = useEnvironmentProviders();
  const machines = useEnvironmentMachines();
  const entries = deriveProviderInstanceEntries(providers.get(listing.environmentId) ?? []);
  const entry = entries.find((candidate) => candidate.instanceId === bot.modelSelection.instanceId);
  const badge = entry !== undefined && shouldShowInstanceBadge(entry, entries);
  const model = entry?.models.find((candidate) => candidate.slug === bot.modelSelection.model);
  const modelLabel = model
    ? getTriggerDisplayModelName(model, entry?.driverKind)
    : bot.modelSelection.model;
  const message = bot.lastMessage;
  const preview = message
    ? `${message.role === "user" ? "You: " : ""}${plainPreview(message.text)}`
    : "No messages yet";
  return (
    <GroupRow
      title={bot.name}
      status={<BotStatus status={status} now={now} />}
      botStatus={status}
      empty={message === null}
      error={message?.role === "error"}
      preview={preview}
      active={active}
      onClick={onClick}
      provider={
        entry ? (
          <ProviderInstanceIcon
            {...entry}
            showBadge={badge}
            size="compact"
            iconClassName="opacity-60"
          />
        ) : null
      }
      tooltip={
        <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
          <ThreadHoverCard
            title={bot.name}
            footer={
              message ? (
                <div className="border-t border-border/60 pt-2 text-xs text-muted-foreground">
                  <p className="line-clamp-3 whitespace-pre-wrap wrap-break-word">
                    {message.role === "user" ? "You: " : ""}
                    {message.text}
                  </p>
                  <div className="mt-1">{agoLabel(message.createdAt, now)}</div>
                </div>
              ) : null
            }
          >
            <div className="flex min-w-0 items-start gap-2">
              <EnvironmentMachineIcon
                kind={machines.get(listing.environmentId) ?? "server"}
                className="size-3 shrink-0 stroke-muted-foreground"
              />
              <span className="min-w-0 wrap-break-word">{listing.label}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              {entry ? (
                <ProviderInstanceIcon
                  {...entry}
                  showBadge={badge && entry.accentColor !== undefined}
                  badgeContent="none"
                  badgeClassName="h-2 min-w-2 px-0"
                  iconClassName="size-3 shrink-0 opacity-60"
                />
              ) : null}
              <span className="min-w-0 wrap-break-word">
                {badge && entry ? `${modelLabel} · ${entry.displayName}` : modelLabel}
              </span>
            </div>
            {status.kind !== "none" && status.kind !== "age" ? (
              <div className="flex items-center">
                <BotStatus status={status} now={now} />
              </div>
            ) : null}
          </ThreadHoverCard>
        </ThreadHoverCardPopup>
      }
    />
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
        onToggle={() => setCollapsed((value) => !value)}
        action={newBot}
      />
      {collapsed ? null : (
        <GroupPanel>
          {rows.map(({ listing, bot, status }) => (
            <BotRow
              key={`${listing.environmentId}:${bot.id}`}
              listing={listing}
              bot={bot}
              status={status}
              now={now}
              active={
                pathname === "/bots" &&
                search.environmentId === listing.environmentId &&
                search.botId === bot.id
              }
              onClick={() => open(listing.environmentId, bot.id)}
            />
          ))}
        </GroupPanel>
      )}
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

function InboxGroup({ inScope }: { readonly inScope: (environmentId: EnvironmentId) => boolean }) {
  const navigate = useNavigate();
  const closeMobile = useCloseMobileSidebar();
  const inboxes = useInboxOverviews().filter((inbox) => inScope(inbox.environmentId));
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
        action={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Open Inbox"
            onClick={() => open(null)}
          >
            <ArrowUpRightIcon aria-hidden />
          </Button>
        }
        onToggle={() => setCollapsed((value) => !value)}
      />
      {collapsed ? null : (
        <GroupPanel>
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
          {more > 0 || items.length === 0 ? (
            <li className="list-none">
              <button
                type="button"
                onClick={() => open(null)}
                className="flex h-7 w-full cursor-pointer items-center rounded-md px-2.5 ps-9 text-left text-xs text-secondary-label outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {more > 0 ? `${more} more` : "All conversations"}
              </button>
            </li>
          ) : null}
        </GroupPanel>
      )}
    </>
  );
}
