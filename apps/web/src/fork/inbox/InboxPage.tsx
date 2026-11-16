import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckCheckIcon,
  InboxIcon,
  ListFilterIcon,
  MessagesSquareIcon,
  PlugZapIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SidebarInset } from "../../components/ui/sidebar";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { ChannelStatusDot, formatSince } from "../presentation";
import type { InboxItem, ItemsResponse, TopicDetail as TopicDetailData } from "../types";
import { useForkResource } from "../useForkResource";
import { ConversationPane } from "./ConversationPane";
import { DelegateDialog } from "./DelegateDialog";
import { InboxList, ItemMenu } from "./InboxList";
import {
  INBOX_FILTERS,
  INBOX_VIEWS,
  channelBanner,
  emptyViewTitle,
  inView,
  nameOrUnknown,
  skippedNotice,
  type InboxFilter,
  type InboxView,
} from "./inboxView";
import { markAllRead, setItemRead, topicPath } from "./itemActions";
import { TopicDetail } from "./TopicDetail";
import { useInboxOverviews, type EnvironmentInbox } from "./useInboxOverviews";

const ENVIRONMENT_STORAGE_KEY = "t3code:fork-inbox-environment";

function readStoredEnvironment(): string | null {
  try {
    return localStorage.getItem(ENVIRONMENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeEnvironment(environmentId: string) {
  try {
    localStorage.setItem(ENVIRONMENT_STORAGE_KEY, environmentId);
  } catch {
    // Private windows may refuse storage; the choice then lasts for this visit.
  }
}

export function InboxPage() {
  const inboxes = useInboxOverviews({ followSync: true });
  const [chosenEnvironment, setChosenEnvironment] = useState<string | null>(readStoredEnvironment);
  const inbox =
    inboxes.find((candidate) => candidate.environmentId === chosenEnvironment) ??
    inboxes[0] ??
    null;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b">
          <h1 className="truncate text-sm font-medium">Inbox</h1>
          {inboxes.length > 1 && inbox ? (
            <Select
              value={inbox.environmentId}
              onValueChange={(value) => {
                if (!value) return;
                setChosenEnvironment(value);
                storeEnvironment(value);
              }}
            >
              <SelectTrigger aria-label="Environment" size="xs" className="w-auto max-w-48">
                <SelectValue>{inbox.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {inboxes.map((candidate) => (
                  <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                    {candidate.label}
                    {candidate.unreadCount > 0 ? ` (${candidate.unreadCount})` : ""}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </WorkspacePageHeader>
        {inbox ? (
          <EnvironmentInboxView key={inbox.environmentId} inbox={inbox} />
        ) : (
          <InboxEmpty
            icon={<PlugZapIcon />}
            title="No channels"
            description="Enable a channel on a connected environment."
            settingsLink
          />
        )}
      </div>
    </SidebarInset>
  );
}

function InboxEmpty({
  icon,
  title,
  description,
  settingsLink = false,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly settingsLink?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <Empty size="compact">
      <EmptyMedia variant="icon">{icon}</EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {settingsLink ? (
        <Button size="sm" variant="outline" render={<Link to="/settings/channels" />}>
          Open settings
        </Button>
      ) : null}
      {children}
    </Empty>
  );
}

function EnvironmentInboxView({ inbox }: { readonly inbox: EnvironmentInbox }) {
  const environmentId = inbox.environmentId;
  const [channelId, setChannelId] = useState<string | null>(null);
  const channel =
    inbox.channels.find((candidate) => candidate.id === channelId) ??
    inbox.channels.find((candidate) => candidate.access.read) ??
    inbox.channels[0]!;
  const [view, setView] = useState<InboxView>("unread");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delegating, setDelegating] = useState<InboxItem | null>(null);
  // Reads sent but not yet read back, shown at once so the list answers the click.
  const [pendingReads, setPendingReads] = useState<
    ReadonlyMap<string, { readonly read: boolean; readonly token: symbol }>
  >(new Map());

  const refreshChannel = (event: { type: string; channelId?: string }) =>
    event.type === "channels" || (event.type === "inbox" && event.channelId === channel.id);
  const listing = useForkResource<ItemsResponse>(
    channel.access.read ? environmentId : null,
    `/inbox/items?channelId=${encodeURIComponent(channel.id)}`,
    refreshChannel,
  );
  const items = (listing.data?.items ?? []).map((item) => {
    const pending = pendingReads.get(item.id);
    if (pending === undefined) return item;
    return pending.read
      ? { ...item, unread: false, agentUnseen: false }
      : { ...item, unread: true };
  });
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const detail = useForkResource<TopicDetailData>(
    selected ? environmentId : null,
    selected ? topicPath(selected) : null,
    refreshChannel,
  );
  const visible = items.filter((item) => inView(view, filter, item, selectedId));
  const readOnly = listing.data?.access.stale ?? !channel.access.send;
  const banner = channelBanner(channel);
  const onSetRead = async (item: InboxItem, read: boolean) => {
    const token = Symbol(item.id);
    const settle = () =>
      setPendingReads((current) => {
        if (current.get(item.id)?.token !== token) return current;
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
    // Unread on the open topic would be read again at once; close it instead.
    if (!read && item.id === selectedId) setSelectedId(null);
    setPendingReads((current) => new Map(current).set(item.id, { read, token }));
    // The event stream may be down; read the list back rather than wait for the poll.
    if (await setItemRead(environmentId, item, read)) await listing.refresh();
    settle();
  };
  const onMarkAllRead = async () => {
    if (await markAllRead(environmentId, channel.id, listing.data?.items ?? [])) {
      await listing.refresh();
    }
  };
  // Selecting is reading. A message that lands while the topic is open stays unread until the
  // user acts on it again (selects it once more, or starts a reply), so the dot never just blinks.
  const readItem = (item: InboxItem) => {
    if (item.unread) void onSetRead(item, true);
  };
  const handlers = {
    onSelect: (item: InboxItem) => {
      setSelectedId(item.id);
      readItem(item);
    },
    onDelegate: (item: InboxItem) => setDelegating(item),
    onSetRead: (item: InboxItem, read: boolean) => void onSetRead(item, read),
  };
  const anyUnread = items.some((item) => item.unread);
  let list: ReactNode;
  if (!channel.access.read) {
    list = <InboxEmpty icon={<PlugZapIcon />} title="Channel unavailable" settingsLink />;
  } else if (listing.data === null && listing.error) {
    list = <ReadError message={listing.error.message} onRetry={() => void listing.refresh()} />;
  } else if (listing.data === null) {
    list = <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>;
  } else if (visible.length === 0) {
    list = (
      <InboxEmpty icon={<InboxIcon />} title={emptyViewTitle(view, filter)}>
        {filter === "all" ? null : (
          <Button size="sm" variant="outline" onClick={() => setFilter("all")}>
            Clear filter
          </Button>
        )}
      </InboxEmpty>
    );
  } else {
    list = (
      <InboxList
        environmentId={environmentId}
        items={visible}
        selectedId={selectedId}
        readOnly={readOnly}
        handlers={handlers}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
        {inbox.channels.length > 1 ? (
          <Select value={channel.id} onValueChange={(value) => value && setChannelId(value)}>
            <SelectTrigger aria-label="Channel" size="xs" className="w-auto max-w-48">
              <SelectValue>{channel.name}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {inbox.channels.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <ChannelStatusDot status={channel.status} />
            <span className="truncate">{channel.name}</span>
          </span>
        )}
        {banner === null ? (
          <span className="text-muted-foreground">
            {channel.selfName ? `${channel.selfName} · ` : ""}synced{" "}
            {formatSince(channel.lastSyncAt)}
          </span>
        ) : (
          <span
            role="status"
            className={cn(
              "min-w-0 flex-1",
              banner.tone === "error" ? "text-destructive-foreground" : "text-warning",
            )}
          >
            {banner.text}
          </span>
        )}
      </div>

      <div className="@container/inbox flex min-h-0 flex-1">
        <section
          aria-label="Topics"
          className={cn(
            "flex min-h-0 w-full flex-col @2xl/inbox:w-80 @2xl/inbox:shrink-0 @2xl/inbox:border-r",
            selected && "@max-2xl/inbox:hidden",
          )}
        >
          <div className="flex shrink-0 items-center gap-2 p-2">
            <ToggleGroup
              value={[view]}
              onValueChange={(next) => {
                const value = next[0] as InboxView | undefined;
                if (value) setView(value);
              }}
              aria-label="Inbox view"
            >
              {INBOX_VIEWS.map((option) => {
                const count = items.filter((item) => inView(option.id, filter, item)).length;
                return (
                  <Toggle key={option.id} value={option.id} aria-label={option.label}>
                    {option.label}
                    {count > 0 && option.id !== "all" ? ` ${count}` : ""}
                  </Toggle>
                );
              })}
            </ToggleGroup>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              className="ms-auto"
              aria-label="Mark all as read"
              title="Mark all as read"
              disabled={!anyUnread}
              onClick={() => void onMarkAllRead()}
            >
              <CheckCheckIcon />
            </Button>
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="ghost-muted" aria-label="Filters" />}>
                <ListFilterIcon />
                {filter === "all" ? null : (
                  <span>{INBOX_FILTERS.find((option) => option.id === filter)?.label}</span>
                )}
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuRadioGroup
                  value={filter}
                  onValueChange={(next) => setFilter(next as InboxFilter)}
                >
                  {INBOX_FILTERS.map((option) => (
                    <MenuRadioItem key={option.id} value={option.id}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        <MenuRadioItemIndicator />
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          </div>
          {listing.data?.truncatedAtPages ? (
            <p className="shrink-0 px-3 pb-1.5 text-xs text-muted-foreground">
              Showing the first {listing.data.truncatedAtPages} pages.
            </p>
          ) : null}
          {listing.data && skippedNotice(listing.data.skipped) ? (
            <p className="shrink-0 px-3 pb-1.5 text-xs text-warning">
              {skippedNotice(listing.data.skipped)}
            </p>
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            {list}
          </div>
        </section>

        {selected ? (
          <ConversationPane
            environmentId={environmentId}
            selected={selected}
            items={items}
            readOnly={readOnly}
            handlers={handlers}
            refreshOn={refreshChannel}
          />
        ) : null}

        <section
          aria-label="Topic"
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col",
            selected && "@5xl/inbox:w-[28rem] @5xl/inbox:flex-none @5xl/inbox:border-l",
            selected ? "flex" : "hidden @2xl/inbox:flex",
          )}
        >
          {selected ? (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Back to the list"
                  className="@2xl/inbox:hidden"
                  onClick={() => setSelectedId(null)}
                >
                  <ArrowLeftIcon />
                </Button>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {nameOrUnknown(selected.conversationName)}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={readOnly}
                  onClick={() => setDelegating(selected)}
                >
                  <BotIcon />
                  Delegate
                </Button>
                <ItemMenu
                  environmentId={environmentId}
                  item={selected}
                  readOnly={readOnly}
                  onDelegate={handlers.onDelegate}
                  onSetRead={handlers.onSetRead}
                />
              </div>
              {detail.data && detail.data.item.id === selected.id ? (
                <TopicDetail
                  environmentId={environmentId}
                  detail={detail.data}
                  sendingOff={readOnly}
                  onEngage={() => readItem(selected)}
                />
              ) : detail.error ? (
                <ReadError message={detail.error.message} onRetry={() => void detail.refresh()} />
              ) : (
                <p className="p-4 text-sm text-muted-foreground">Loading…</p>
              )}
            </>
          ) : (
            <InboxEmpty icon={<MessagesSquareIcon />} title="No topic selected" />
          )}
        </section>
      </div>

      {delegating ? (
        <DelegateDialog
          environmentId={environmentId}
          item={delegating}
          onClose={() => setDelegating(null)}
        />
      ) : null}
    </div>
  );
}

function ReadError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-6">
      <p className="text-sm text-destructive-foreground">{message}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
