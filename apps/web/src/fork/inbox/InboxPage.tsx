import { ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  CheckCheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  InboxIcon,
  ListFilterIcon,
  MessagesSquareIcon,
  PlugZapIcon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { RightPanelResizeHandle } from "../../components/preview/RightPanelResizeHandle";
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
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../../hooks/useResizableWidth";
import { cn } from "../../lib/utils";
import { ChannelStatusDot, formatSince } from "../presentation";
import type { DelegationDetail, InboxConversation, InboxDelegation, InboxResponse } from "../types";
import { useForkResource } from "../useForkResource";
import { ConversationPane, nextReplyNonce, type ReplyRequest } from "./ConversationPane";
import { DelegateDialog, type DelegateTarget } from "./DelegateDialog";
import { DelegationPane } from "./DelegationPane";
import { IconAction } from "./IconAction";
import { ConversationList, DelegationList } from "./InboxList";
import {
  INBOX_FILTERS,
  INBOX_VIEWS,
  agentSignalsByConversation,
  channelBanner,
  emptyViewTitle,
  inView,
  matchesFilter,
  quoteOfMessage,
  skippedNotice,
  type InboxFilter,
  type InboxView,
} from "./inboxView";
import {
  copyDelegationContext,
  delegationPath,
  discardDraft,
  discardDrafts,
  markAllRead,
  markDelegationSeen,
  setConversationRead,
} from "./itemActions";
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
  const navigate = useNavigate();
  const listWidth = useResizableWidth({
    storageKey: "t3code:inbox-list-width",
    defaultWidth: 320,
    // The view toggle and its two buttons fit down to here.
    minWidth: 280,
    maxWidth: 480,
    edge: "right",
  });
  const delegationWidth = useResizableWidth({
    storageKey: "t3code:inbox-delegation-width",
    defaultWidth: 448,
    minWidth: 320,
    maxWidth: 720,
    edge: "left",
  });
  const [channelId, setChannelId] = useState<string | null>(null);
  const channel =
    inbox.channels.find((candidate) => candidate.id === channelId) ??
    inbox.channels.find((candidate) => candidate.access.read) ??
    inbox.channels[0]!;
  const [view, setView] = useState<InboxView>("unread");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [delegationId, setDelegationId] = useState<string | null>(null);
  const [delegating, setDelegating] = useState<DelegateTarget | null>(null);
  const [replyRequest, setReplyRequest] = useState<ReplyRequest | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Reads sent but not yet read back, shown at once so the list answers the click.
  const [pendingReads, setPendingReads] = useState<
    ReadonlyMap<string, { readonly read: boolean; readonly token: symbol }>
  >(new Map());

  const refreshChannel = (event: { type: string; channelId?: string }) =>
    event.type === "channels" || (event.type === "inbox" && event.channelId === channel.id);
  const listing = useForkResource<InboxResponse>(
    channel.access.read ? environmentId : null,
    `/inbox/conversations?channelId=${encodeURIComponent(channel.id)}`,
    refreshChannel,
  );
  const conversations = (listing.data?.conversations ?? []).map((conversation) => {
    const pending = pendingReads.get(conversation.id);
    if (pending === undefined) return conversation;
    return pending.read
      ? { ...conversation, unread: false, mentioned: false }
      : { ...conversation, unread: true };
  });
  const delegations = listing.data?.delegations ?? [];
  const agentSignals = agentSignalsByConversation(delegations);
  const kindOf = new Map(conversations.map((conversation) => [conversation.id, conversation.kind]));
  const delegation = delegations.find((candidate) => candidate.id === delegationId) ?? null;
  const conversation = conversations.find((candidate) => candidate.id === conversationId) ?? null;
  const detail = useForkResource<DelegationDetail>(
    delegation ? environmentId : null,
    delegation ? delegationPath(channel.id, delegation.id) : null,
    refreshChannel,
  );
  const visibleConversations = conversations.filter(
    (candidate) =>
      view !== "agent" &&
      inView(view, filter, candidate, agentSignals.get(candidate.id), conversationId),
  );
  const visibleDelegations = delegations.filter((candidate) =>
    matchesFilter(filter, kindOf.get(candidate.conversationId)),
  );
  const readOnly = listing.data?.access.stale ?? !channel.access.send;
  const banner = channelBanner(channel);

  const onSetRead = async (target: InboxConversation, read: boolean) => {
    const token = Symbol(target.id);
    const settle = () =>
      setPendingReads((current) => {
        if (current.get(target.id)?.token !== token) return current;
        const next = new Map(current);
        next.delete(target.id);
        return next;
      });
    // Unread on the open conversation would be read again at once; close it instead.
    if (!read && target.id === conversationId) {
      setConversationId(null);
      setDelegationId(null);
    }
    setPendingReads((current) => new Map(current).set(target.id, { read, token }));
    // The event stream may be down; read the list back rather than wait for the poll.
    if (await setConversationRead(environmentId, target, read)) await listing.refresh();
    settle();
  };
  // Opening is reading. A message that lands while the conversation is open stays unread until
  // the user acts on it again (opens it once more, or starts a reply), so the dot never just blinks.
  const readConversation = (target: InboxConversation) => {
    if (target.unread || target.mentioned) void onSetRead(target, true);
  };
  const seeDelegation = async (target: InboxDelegation) => {
    if (target.agentUnseen && (await markDelegationSeen(environmentId, target))) {
      await listing.refresh();
    }
  };
  const selectConversation = (target: InboxConversation) => {
    setConversationId(target.id);
    setDelegationId(null);
    readConversation(target);
  };
  const selectDelegation = (target: InboxDelegation) => {
    setConversationId(target.conversationId);
    setDelegationId(target.id);
    void seeDelegation(target);
  };
  const onDiscardDrafts = async (target: InboxConversation) => {
    const drafted = delegations.filter(
      (candidate) => candidate.conversationId === target.id && candidate.hasDraft,
    );
    if (await discardDrafts(environmentId, drafted)) await listing.refresh();
  };
  const onMarkAllRead = async () => {
    if (await markAllRead(environmentId, channel.id, conversations, delegations)) {
      await listing.refresh();
    }
  };
  const anyUnread =
    conversations.some((candidate) => candidate.unread || candidate.mentioned) ||
    delegations.some((candidate) => candidate.agentUnseen);

  let list: ReactNode;
  if (!channel.access.read) {
    list = <InboxEmpty icon={<PlugZapIcon />} title="Channel unavailable" settingsLink />;
  } else if (listing.data === null && listing.error) {
    list = <ReadError message={listing.error.message} onRetry={() => void listing.refresh()} />;
  } else if (listing.data === null) {
    list = <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>;
  } else if (
    view === "agent" ? visibleDelegations.length === 0 : visibleConversations.length === 0
  ) {
    list = (
      <InboxEmpty
        icon={view === "agent" ? <BotIcon /> : <InboxIcon />}
        title={emptyViewTitle(view, filter)}
      >
        {filter === "all" ? null : (
          <Button size="sm" variant="outline" onClick={() => setFilter("all")}>
            Clear filter
          </Button>
        )}
      </InboxEmpty>
    );
  } else if (view === "agent") {
    list = (
      <DelegationList
        environmentId={environmentId}
        delegations={visibleDelegations}
        kindOf={kindOf}
        selectedId={delegationId}
        onSelect={selectDelegation}
      />
    );
  } else {
    list = (
      <ConversationList
        conversations={visibleConversations}
        agentSignals={agentSignals}
        selectedId={conversationId}
        handlers={{
          onSelect: selectConversation,
          onSetRead: (target, read) => void onSetRead(target, read),
          onDiscardDrafts: (target) => void onDiscardDrafts(target),
        }}
      />
    );
  }

  const viewCount = (option: InboxView) =>
    option === "agent"
      ? delegations.filter((candidate) => candidate.agentUnseen).length
      : option === "unread"
        ? conversations.filter((candidate) =>
            inView("unread", filter, candidate, agentSignals.get(candidate.id)),
          ).length
        : 0;
  const delegationOpen = delegation !== null;
  const conversationShown = conversation !== null;

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

      <div ref={containerRef} className="@container/inbox flex min-h-0 flex-1">
        <section
          aria-label={view === "agent" ? "Delegations" : "Conversations"}
          className={cn(
            "relative flex min-h-0 w-full flex-col @2xl/inbox:w-(--resizable-width) @2xl/inbox:shrink-0 @2xl/inbox:border-r",
            (conversationShown || delegationOpen) && "@max-2xl/inbox:hidden",
          )}
          style={{ [RESIZABLE_WIDTH_PROPERTY]: `${listWidth.width}px` } as CSSProperties}
        >
          <RightPanelResizeHandle
            handlers={listWidth.handlers}
            label="Resize the list"
            className="-right-1 left-auto hidden @2xl/inbox:block any-pointer-coarse:-right-2 any-pointer-coarse:left-auto"
          />
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
                const count = viewCount(option.id);
                return (
                  <Toggle key={option.id} value={option.id} aria-label={option.label}>
                    {option.label}
                    {count > 0 ? ` ${count}` : ""}
                  </Toggle>
                );
              })}
            </ToggleGroup>
            <IconAction
              label="Mark all as read"
              className="ms-auto"
              disabled={!anyUnread}
              onClick={() => void onMarkAllRead()}
            >
              <CheckCheckIcon />
            </IconAction>
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

        {conversation ? (
          <ConversationPane
            environmentId={environmentId}
            conversation={conversation}
            delegations={delegations.filter(
              (candidate) => candidate.conversationId === conversation.id,
            )}
            selectedDelegationId={delegationId}
            onCloseDelegation={() => setDelegationId(null)}
            focusMessageId={delegation?.anchorMessageId ?? null}
            readOnly={readOnly}
            capabilities={channel.capabilities}
            replyRequest={replyRequest}
            refreshOn={refreshChannel}
            // With a delegation open, the chat shares the width only on a wide screen.
            className={delegationOpen ? "hidden @5xl/inbox:flex" : "flex"}
            handlers={{
              onBack: () => {
                setConversationId(null);
                setDelegationId(null);
              },
              onSetRead: (target, read) => void onSetRead(target, read),
              onDiscardDrafts: (target) => void onDiscardDrafts(target),
              onSelectDelegation: selectDelegation,
              onDelegate: (message, later) =>
                setDelegating({
                  channelId: channel.id,
                  conversation: {
                    id: conversation.id,
                    name: conversation.name,
                    kind: conversation.kind,
                  },
                  message,
                  later,
                }),
              onEngage: () => readConversation(conversation),
            }}
          />
        ) : delegationOpen ? null : (
          <section className="hidden min-h-0 min-w-0 flex-1 flex-col @2xl/inbox:flex">
            <InboxEmpty icon={<MessagesSquareIcon />} title="No conversation selected" />
          </section>
        )}

        {delegation ? (
          <section
            aria-label="Delegation"
            className={cn(
              "relative flex min-h-0 min-w-0 flex-1 flex-col",
              conversation &&
                "@5xl/inbox:w-(--resizable-width) @5xl/inbox:flex-none @5xl/inbox:border-l",
            )}
            style={{ [RESIZABLE_WIDTH_PROPERTY]: `${delegationWidth.width}px` } as CSSProperties}
          >
            {conversation ? (
              <RightPanelResizeHandle
                handlers={delegationWidth.handlers}
                label="Resize the delegation"
                className="hidden @5xl/inbox:block"
              />
            ) : null}
            <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={conversation ? "Back to the conversation" : "Back to the list"}
                className="@5xl/inbox:hidden"
                onClick={() => setDelegationId(null)}
              >
                <ArrowLeftIcon />
              </Button>
              <span className="min-w-0 flex-1 truncate px-1 text-xs font-medium">
                {delegation.conversationName ? (
                  <span className="text-muted-foreground @5xl/inbox:hidden">
                    {delegation.conversationName} ·{" "}
                  </span>
                ) : null}
                {delegation.thread?.title ?? delegation.preview ?? "Delegation"}
              </span>
              {delegation.thread && delegation.thread.status !== "deleted" ? (
                <IconAction
                  label="Open thread"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: {
                        environmentId,
                        threadId: ThreadId.make(delegation.thread!.threadId),
                      },
                    })
                  }
                >
                  <ExternalLinkIcon />
                </IconAction>
              ) : null}
              {detail.data && detail.data.delegation.id === delegation.id ? (
                <DelegationActions
                  detail={detail.data}
                  readOnly={readOnly}
                  onDelegateAgain={(target) => setDelegating(target)}
                />
              ) : null}
              <span className="hidden @5xl/inbox:inline-flex">
                <IconAction label="Close delegation" onClick={() => setDelegationId(null)}>
                  <XIcon />
                </IconAction>
              </span>
            </div>
            {detail.data && detail.data.delegation.id === delegation.id ? (
              <DelegationPane
                environmentId={environmentId}
                detail={detail.data}
                sendingOff={readOnly}
                onDiscardDraft={(draftText) =>
                  void discardDraft(environmentId, delegation, draftText).then(async (ok) => {
                    if (ok) await Promise.all([detail.refresh(), listing.refresh()]);
                  })
                }
                onUseDraft={(text) => {
                  const data = detail.data!;
                  const anchor = data.messages.find(
                    (message) => message.id === delegation.anchorMessageId,
                  );
                  // A reply thread's draft answers in that thread; a range's is a new message.
                  const inThread =
                    data.conversation.kind !== "dm" && delegation.scope !== "range" && anchor;
                  setReplyRequest({
                    nonce: nextReplyNonce(),
                    conversationId: delegation.conversationId,
                    replyTo: inThread
                      ? { messageId: anchor.id, quote: quoteOfMessage(anchor) }
                      : null,
                    draft: { text, delegationId: delegation.id },
                  });
                  // On a narrow screen the reply box is in the conversation.
                  if ((containerRef.current?.clientWidth ?? 0) < 1024) setDelegationId(null);
                }}
              />
            ) : detail.error ? (
              <ReadError message={detail.error.message} onRetry={() => void detail.refresh()} />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            )}
          </section>
        ) : null}
      </div>

      {delegating ? (
        <DelegateDialog
          environmentId={environmentId}
          target={delegating}
          onClose={() => setDelegating(null)}
          onDelegated={(id) => {
            setDelegating(null);
            setDelegationId(id);
            void listing.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function DelegationActions({
  detail,
  readOnly,
  onDelegateAgain,
}: {
  readonly detail: DelegationDetail;
  readonly readOnly: boolean;
  readonly onDelegateAgain: (target: DelegateTarget) => void;
}) {
  const anchor = detail.messages.find(
    (message) => message.id === detail.delegation.anchorMessageId,
  );
  return (
    <>
      <IconAction label="Copy the messages" onClick={() => void copyDelegationContext(detail)}>
        <CopyIcon />
      </IconAction>
      <IconAction
        label="Delegate again"
        disabled={readOnly || anchor === undefined}
        onClick={() =>
          anchor &&
          onDelegateAgain({
            channelId: detail.delegation.channelId,
            conversation: detail.conversation,
            message: anchor,
            later: detail.messages.filter((message) => message.id !== anchor.id),
            scope: detail.delegation.scope,
          })
        }
      >
        <BotIcon />
      </IconAction>
    </>
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
