import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeOffIcon,
} from "lucide-react";
import { useState } from "react";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Button } from "../../components/ui/button";
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
import type {
  ChannelAccess,
  ChannelStatus,
  InboxItem,
  TopicDetail as TopicDetailData,
} from "../types";
import { useForkResource } from "../useForkResource";
import { DelegateDialog } from "./DelegateDialog";
import { InboxList, ItemMenu } from "./InboxList";
import {
  INBOX_VIEWS,
  STATE_LABELS,
  channelBanner,
  inView,
  waitLabel,
  type InboxView,
} from "./inboxView";
import { copyItemContext, markItem, openItemInApp, topicPath } from "./itemActions";
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

interface ItemsResponse {
  readonly items: ReadonlyArray<InboxItem>;
  readonly stale: boolean;
  readonly access: ChannelAccess;
  readonly status: ChannelStatus;
}

export function InboxPage() {
  const inboxes = useInboxOverviews();
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
                    {candidate.pendingCount > 0 ? ` (${candidate.pendingCount})` : ""}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}
        </WorkspacePageHeader>
        {inbox ? (
          <EnvironmentInboxView key={inbox.environmentId} inbox={inbox} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              No channel is enabled on a connected environment.
            </p>
            <Button size="sm" variant="outline" render={<Link to="/settings/channels" />}>
              Open Settings → Channels
            </Button>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

function EnvironmentInboxView({ inbox }: { readonly inbox: EnvironmentInbox }) {
  const environmentId = inbox.environmentId;
  const [channelId, setChannelId] = useState<string | null>(null);
  const channel =
    inbox.channels.find((candidate) => candidate.id === channelId) ??
    inbox.channels.find((candidate) => candidate.access.read) ??
    inbox.channels[0]!;
  const [view, setView] = useState<InboxView>("pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [delegating, setDelegating] = useState<InboxItem | null>(null);

  const refreshChannel = (event: { type: string; channelId?: string }) =>
    event.type === "channels" || (event.type === "inbox" && event.channelId === channel.id);
  const listing = useForkResource<ItemsResponse>(
    channel.access.read ? environmentId : null,
    `/inbox/items?channelId=${encodeURIComponent(channel.id)}`,
    refreshChannel,
  );
  const items = listing.data?.items ?? [];
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const detail = useForkResource<TopicDetailData>(
    selected ? environmentId : null,
    selected ? topicPath(selected) : null,
    refreshChannel,
  );
  const visible = items.filter((item) => inView(view, item));
  const readOnly = listing.data?.access.stale ?? !channel.access.send;
  const banner = channelBanner(channel);
  const handlers = {
    onSelect: (item: InboxItem) => setSelectedId(item.id),
    onDelegate: (item: InboxItem) => setDelegating(item),
  };
  const conversationTopics = selected
    ? items
        .filter((item) => item.conversationId === selected.conversationId)
        .toSorted((left, right) => right.lastMessageAt.localeCompare(left.lastMessageAt))
    : [];

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
            {banner.text}{" "}
            {banner.showSettingsLink ? (
              <Link to="/settings/channels" className="underline underline-offset-2">
                Settings → Channels
              </Link>
            ) : null}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Topics"
          className={cn(
            "flex min-h-0 w-full flex-col border-r md:w-80 md:shrink-0",
            selected && "max-md:hidden",
          )}
        >
          <div className="shrink-0 overflow-x-auto p-2">
            <ToggleGroup
              value={[view]}
              onValueChange={(next) => {
                const value = next[0] as InboxView | undefined;
                if (value) setView(value);
              }}
              aria-label="Inbox view"
            >
              {INBOX_VIEWS.map((option) => {
                const count = items.filter((item) => inView(option.id, item)).length;
                return (
                  <Toggle key={option.id} value={option.id} aria-label={option.label}>
                    {option.label}
                    {count > 0 && (option.id === "pending" || option.id === "waiting")
                      ? ` ${count}`
                      : ""}
                  </Toggle>
                );
              })}
            </ToggleGroup>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {listing.error ? (
              <p className="px-4 py-6 text-sm text-destructive-foreground">
                {listing.error.message}
              </p>
            ) : listing.data === null && channel.access.read ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
            ) : (
              <InboxList
                environmentId={environmentId}
                items={visible}
                selectedId={selectedId}
                readOnly={readOnly}
                emptyText={channel.access.read ? "Nothing here." : "This channel cannot be read."}
                handlers={handlers}
              />
            )}
          </div>
        </section>

        <section
          aria-label="Conversation"
          className="scrollbar-gutter-both hidden min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain xl:flex"
        >
          {selected ? (
            <>
              <h2 className="sticky top-0 border-b bg-background px-4 py-2 text-xs font-medium">
                {selected.conversationName}
              </h2>
              <ul className="flex flex-col gap-2 p-3">
                {conversationTopics.map((topic) => (
                  <TopicCard
                    key={topic.id}
                    environmentId={environmentId}
                    item={topic}
                    selected={topic.id === selected.id}
                    readOnly={readOnly}
                    onSelect={() => setSelectedId(topic.id)}
                    onDelegate={() => setDelegating(topic)}
                  />
                ))}
              </ul>
            </>
          ) : (
            <p className="m-auto text-sm text-muted-foreground">Choose a topic.</p>
          )}
        </section>

        <section
          aria-label="Topic"
          className={cn(
            "min-h-0 min-w-0 flex-1 flex-col xl:w-[28rem] xl:flex-none xl:border-l",
            selected ? "flex" : "hidden md:flex",
          )}
        >
          {selected ? (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Back to the list"
                  className="md:hidden"
                  onClick={() => setSelectedId(null)}
                >
                  <ArrowLeftIcon />
                </Button>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {selected.conversationName}
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
                />
              </div>
              {detail.data && detail.data.item.id === selected.id ? (
                <TopicDetail
                  environmentId={environmentId}
                  detail={detail.data}
                  readOnly={readOnly}
                />
              ) : detail.error ? (
                <p className="p-4 text-sm text-destructive-foreground">{detail.error.message}</p>
              ) : (
                <p className="p-4 text-sm text-muted-foreground">Loading…</p>
              )}
            </>
          ) : (
            <p className="m-auto text-sm text-muted-foreground">Choose a topic.</p>
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

function TopicCard({
  environmentId,
  item,
  selected,
  readOnly,
  onSelect,
  onDelegate,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly onSelect: () => void;
  readonly onDelegate: () => void;
}) {
  const marked = item.state === "done" || item.state === "ignored";
  return (
    <li
      className={cn(
        "group relative rounded-lg border border-border/70 p-3",
        selected && "border-primary/50 bg-accent/40",
      )}
    >
      <button
        type="button"
        className="flex w-full min-w-0 flex-col gap-1 text-left"
        onClick={onSelect}
      >
        <span className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
          <span className="truncate">{STATE_LABELS[item.state]}</span>
          <span className="ms-auto shrink-0 tabular-nums">{waitLabel(item)}</span>
        </span>
        <span className="text-sm break-words whitespace-pre-wrap">{item.preview}</span>
        <span className="text-xs text-muted-foreground">
          {item.replyCount} {item.replyCount === 1 ? "reply" : "replies"} · last from{" "}
          {item.lastAuthor.isSelf ? "you" : item.lastAuthor.name}
        </span>
      </button>
      <div className="absolute -top-3 right-2 hidden gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Delegate"
          disabled={readOnly}
          onClick={onDelegate}
        >
          <BotIcon />
        </Button>
        {marked ? null : (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Mark done"
              onClick={() => void markItem(environmentId, item, "done")}
            >
              <CheckIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Ignore"
              onClick={() => void markItem(environmentId, item, "ignored")}
            >
              <EyeOffIcon />
            </Button>
          </>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Copy context"
          onClick={() => void copyItemContext(environmentId, item)}
        >
          <CopyIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open in app"
          onClick={() => void openItemInApp(environmentId, item)}
        >
          <ExternalLinkIcon />
        </Button>
      </div>
    </li>
  );
}
