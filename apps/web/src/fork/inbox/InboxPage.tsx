import { ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  CircleCheckIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  InboxIcon,
  ListFilterIcon,
  LocateFixedIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

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
  MenuItem,
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../../hooks/useResizableWidth";
import { cn } from "../../lib/utils";
import { ChannelStatusDot, formatSince } from "../presentation";
import type { DelegationDetail, InboxConversation, InboxDelegation, InboxResponse } from "../types";
import { useForkResource } from "../useForkResource";
import {
  ConversationPane,
  forgetPlace,
  type FocusRequest,
  namedInReply,
  replyTargetOf,
  type ReplyTarget,
} from "./ConversationPane";
import { DelegateDialog, type DelegateTarget } from "./DelegateDialog";
import { DelegationPane, ThreadStatus, useBlockedThreadIds } from "./DelegationPane";
import { IconAction } from "./IconAction";
import { PaneHeader } from "./PaneHeader";
import { ConversationList, type ConversationListItem } from "./InboxList";
import { readMentionable, sendReply } from "./sendReply";
import {
  INBOX_FILTERS,
  channelBanner,
  draftReplyMode,
  emptyListTitle,
  followUpNeedsYou,
  matchesFilter,
  needsYou,
  replyModes,
  topFollowUp,
  skippedNotice,
  type InboxFilter,
} from "./inboxView";
import {
  copyDelegationContext,
  delegationPath,
  discardDraft,
  discardDrafts,
  markDelegationSeen,
  setConversationRead,
  settleDelegation,
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

interface RememberedView {
  readonly channelId: string | null;
  readonly filter: InboxFilter;
  readonly conversationId: string | null;
  readonly opened: { readonly id: string; readonly newSince: string | null };
  readonly heldId: string | null;
  readonly delegationId: string | null;
}

// Leaving the page unmounts it; coming back opens it where it was left, per environment.
const rememberedViews = new Map<string, Partial<RememberedView>>();

function useRemembered(environmentId: string) {
  const [state, setState] = useState(() => rememberedViews.get(environmentId) ?? {});
  return <K extends keyof RememberedView>(key: K, initial: RememberedView[K]) =>
    [
      (key in state ? state[key] : initial) as RememberedView[K],
      (value: RememberedView[K]) => {
        const next = { ...rememberedViews.get(environmentId), [key]: value };
        rememberedViews.set(environmentId, next);
        setState(next);
      },
    ] as const;
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
        {inbox ? (
          <EnvironmentInboxView
            key={inbox.environmentId}
            inbox={inbox}
            environmentPicker={
              inboxes.length > 1 ? (
                <Select
                  value={inbox.environmentId}
                  onValueChange={(value) => {
                    if (!value) return;
                    setChosenEnvironment(value);
                    storeEnvironment(value);
                  }}
                >
                  <SelectTrigger aria-label="Environment" size="xs" className="w-auto min-w-0">
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
              ) : null
            }
          />
        ) : (
          <>
            <PaneHeader edge="list">
              <h1 className="truncate px-1 text-sm font-medium">Inbox</h1>
            </PaneHeader>
            <InboxEmpty
              icon={<MessagesSquareIcon />}
              title="No channels"
              description="Enable a channel on a connected environment."
              settingsLink
            />
          </>
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

function EnvironmentInboxView({
  inbox,
  environmentPicker,
}: {
  readonly inbox: EnvironmentInbox;
  readonly environmentPicker: ReactNode;
}) {
  const environmentId = inbox.environmentId;
  const navigate = useNavigate();
  const listWidth = useResizableWidth({
    storageKey: "t3code:inbox-list-width",
    defaultWidth: 320,
    // The header's name, channel, and two buttons fit down to here.
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
  const remember = useRemembered(environmentId);
  const [channelId, setChannelId] = remember("channelId", null);
  const channel =
    inbox.channels.find((candidate) => candidate.id === channelId) ??
    inbox.channels.find((candidate) => candidate.access.read) ??
    inbox.channels[0]!;
  const [filter, setFilter] = remember("filter", "all");
  const [conversationId, setConversationId] = remember("conversationId", null);
  // Opening reads the conversation, so where its new messages start is taken before that.
  const [opened, setOpened] = remember("opened", { id: "", newSince: null });
  // Opened from Needs you, it stays there while open, so reading it does not move it under the pointer.
  const [heldId, setHeldId] = remember("heldId", null);
  const [delegationId, setDelegationId] = remember("delegationId", null);
  const [delegating, setDelegating] = useState<DelegateTarget | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Reads sent but not yet read back, shown at once so the list answers the click.
  const [pendingReads, setPendingReads] = useState<ReadonlySet<string>>(new Set());

  const refreshChannel = (event: { type: string; channelId?: string }) =>
    event.type === "channels" || (event.type === "inbox" && event.channelId === channel.id);
  const listing = useForkResource<InboxResponse>(
    channel.access.read ? environmentId : null,
    `/inbox/conversations?channelId=${encodeURIComponent(channel.id)}`,
    refreshChannel,
  );
  const conversations = (listing.data?.conversations ?? []).map((conversation) =>
    pendingReads.has(conversation.id)
      ? { ...conversation, unread: false, mentioned: false }
      : conversation,
  );
  const delegations = listing.data?.delegations ?? [];
  const openFollowUps = new Map<string, InboxDelegation[]>();
  for (const candidate of delegations) {
    if (candidate.settledAt !== null) continue;
    const list = openFollowUps.get(candidate.conversationId) ?? [];
    list.push(candidate);
    openFollowUps.set(candidate.conversationId, list);
  }
  const followUpsOf = (id: string) => openFollowUps.get(id) ?? [];
  const blockedThreadIds = useBlockedThreadIds(environmentId);
  const delegation = delegations.find((candidate) => candidate.id === delegationId) ?? null;
  const conversation = conversations.find((candidate) => candidate.id === conversationId) ?? null;
  const detail = useForkResource<DelegationDetail>(
    delegation ? environmentId : null,
    delegation ? delegationPath(channel.id, delegation.id) : null,
    refreshChannel,
  );
  const visibleConversations = conversations.filter((candidate) =>
    matchesFilter(filter, candidate.kind),
  );
  const listItems = listItemsFor(visibleConversations, followUpsOf, heldId, blockedThreadIds);
  const readOnly = listing.data?.access.stale ?? !channel.access.send;
  const draftReply = draftReplyOf(detail.data, delegation, channel.capabilities);
  const banner = channelBanner(channel);
  const syncedLabel = `${channel.selfName ? `${channel.selfName} · ` : ""}synced ${formatSince(channel.lastSyncAt)}`;

  // Opening is reading. A message that lands while the conversation is open stays unread until
  // the user acts on it again (opens it once more, or starts a reply), so the dot never just blinks.
  const readConversation = async (target: InboxConversation) => {
    if (!target.unread && !target.mentioned) return;
    setPendingReads((current) => new Set(current).add(target.id));
    // The event stream may be down; read the list back rather than wait for the poll.
    if (await setConversationRead(environmentId, target, true)) await listing.refresh();
    setPendingReads((current) => {
      const next = new Set(current);
      next.delete(target.id);
      return next;
    });
  };
  const seeDelegation = async (target: InboxDelegation) => {
    if (target.agentUnseen && (await markDelegationSeen(environmentId, target))) {
      await listing.refresh();
    }
  };
  // Opening lands at the reading place, and opens the follow-up waiting on you beside it.
  const selectConversation = (target: InboxConversation) => {
    setConversationId(target.id);
    setOpened({ id: target.id, newSince: target.unread ? target.readThroughAt : null });
    forgetPlace(environmentId, target);
    setFocus(null);
    // Without room for both, the chat comes first; the follow-up opens from its header.
    const wide = (containerRef.current?.clientWidth ?? 0) >= WIDE_INBOX_PX;
    const waiting = wide
      ? (followUpsOf(target.id).find((candidate) =>
          followUpNeedsYou(candidate, blockedThreadIds),
        ) ?? null)
      : null;
    setDelegationId(waiting?.id ?? null);
    if (waiting) void seeDelegation(waiting);
    setHeldId(needsYou(target, followUpsOf(target.id), blockedThreadIds) ? target.id : null);
    void readConversation(target);
  };
  const selectDelegation = (target: InboxDelegation) => {
    setDelegationId(target.id);
    void seeDelegation(target);
  };
  const showMessage = (target: InboxDelegation) => {
    setFocus({ messageId: target.anchorMessageId });
    // Without room for both, the chat takes the follow-up's place.
    if ((containerRef.current?.clientWidth ?? Infinity) < WIDE_INBOX_PX) setDelegationId(null);
  };
  const onSettle = async (target: InboxDelegation, settled: boolean) => {
    if (await settleDelegation(environmentId, target, settled)) await listing.refresh();
  };
  const onDiscardDrafts = async (target: InboxConversation) => {
    const drafted = delegations.filter(
      (candidate) => candidate.conversationId === target.id && candidate.hasDraft,
    );
    if (await discardDrafts(environmentId, drafted)) await listing.refresh();
  };

  let list: ReactNode;
  if (!channel.access.read) {
    list = <InboxEmpty icon={<MessagesSquareIcon />} title="Channel unavailable" settingsLink />;
  } else if (listing.data === null && listing.error) {
    list = <ReadError message={listing.error.message} onRetry={() => void listing.refresh()} />;
  } else if (listing.data === null) {
    list = <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>;
  } else if (visibleConversations.length === 0) {
    list = (
      <InboxEmpty icon={<InboxIcon />} title={emptyListTitle(filter)}>
        {filter === "all" ? null : (
          <Button size="sm" variant="outline" onClick={() => setFilter("all")}>
            Clear filter
          </Button>
        )}
      </InboxEmpty>
    );
  } else {
    list = (
      <ConversationList
        environmentId={environmentId}
        items={listItems}
        selectedId={conversationId}
        handlers={{ onSelect: selectConversation }}
      />
    );
  }

  const delegationOpen = delegation !== null;
  const conversationShown = conversation !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={containerRef} className="@container/inbox flex min-h-0 flex-1">
        <section
          aria-label="Conversations"
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
          <PaneHeader edge="list">
            <h1 className="shrink-0 px-1 text-sm font-medium">Inbox</h1>
            {environmentPicker}
            <Tooltip>
              <TooltipTrigger
                render={<span className="flex shrink-0 p-1" aria-label={syncedLabel} />}
              >
                <ChannelStatusDot status={channel.status} />
              </TooltipTrigger>
              <TooltipPopup>{syncedLabel}</TooltipPopup>
            </Tooltip>
            {inbox.channels.length > 1 ? (
              <Select value={channel.id} onValueChange={(value) => value && setChannelId(value)}>
                <SelectTrigger aria-label="Channel" size="xs" className="w-auto min-w-0">
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
              <span className="min-w-0 truncate text-xs text-muted-foreground">{channel.name}</span>
            )}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    aria-label="Filters"
                    className="ms-auto"
                  />
                }
              >
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
          </PaneHeader>
          {banner === null ? null : (
            <p
              role="status"
              className={cn(
                "shrink-0 border-b px-3 py-1.5 text-xs",
                banner.tone === "error" ? "text-destructive-foreground" : "text-warning",
              )}
            >
              {banner.text}
            </p>
          )}
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
            focus={focus}
            newSince={opened.id === conversation.id ? opened.newSince : null}
            readOnly={readOnly}
            capabilities={channel.capabilities}
            refreshOn={refreshChannel}
            // With a delegation open, the chat shares the width only on a wide screen.
            className={delegationOpen ? "hidden @5xl/inbox:flex" : "flex"}
            handlers={{
              onBack: () => {
                setConversationId(null);
                setDelegationId(null);
              },
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
              onEngage: () => void readConversation(conversation),
            }}
          />
        ) : delegationOpen ? null : (
          <section className="hidden min-h-0 min-w-0 flex-1 flex-col @2xl/inbox:flex">
            <PaneHeader edge="detail" />
            <InboxEmpty icon={<MessageSquareIcon />} title="No conversation selected" />
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
            <PaneHeader edge="detail">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={conversation ? "Back to the conversation" : "Back to the list"}
                className="@5xl/inbox:hidden"
                onClick={() => setDelegationId(null)}
              >
                <ArrowLeftIcon />
              </Button>
              <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
                {delegation.conversationName ? (
                  <span className="text-muted-foreground @5xl/inbox:hidden">
                    {delegation.conversationName} ·{" "}
                  </span>
                ) : null}
                {delegation.thread?.title ?? delegation.preview ?? "Delegation"}
              </span>
              {delegation.thread && delegation.thread.status !== "deleted" ? (
                <ThreadStatus environmentId={environmentId} thread={delegation.thread} />
              ) : null}
              {conversation ? (
                <IconAction label="Show the message" onClick={() => showMessage(delegation)}>
                  <LocateFixedIcon />
                </IconAction>
              ) : null}
              {detail.data && detail.data.delegation.id === delegation.id ? (
                <DelegationActions
                  detail={detail.data}
                  settled={delegation.settledAt !== null}
                  readOnly={readOnly}
                  onOpenThread={(threadId) =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: ThreadId.make(threadId) },
                    })
                  }
                  onDelegateAgain={(target) => setDelegating(target)}
                  onSettle={(settled) => void onSettle(delegation, settled)}
                />
              ) : null}
              <span className="hidden @5xl/inbox:inline-flex">
                <IconAction label="Close delegation" onClick={() => setDelegationId(null)}>
                  <XIcon />
                </IconAction>
              </span>
            </PaneHeader>
            {detail.data && detail.data.delegation.id === delegation.id ? (
              <DelegationPane
                environmentId={environmentId}
                detail={detail.data}
                draftReply={
                  draftReply === null
                    ? null
                    : {
                        text: draftReply.text,
                        target: draftReply.replyTo
                          ? `${draftReply.replyTo.inThread === true ? "In thread to" : "Replying to"} ${draftReply.replyTo.quote}`
                          : null,
                      }
                }
                sendingOff={readOnly}
                onDiscardDraft={() =>
                  void discardDraft(environmentId, delegation, detail.data!.draft!.trim()).then(
                    async (ok) => {
                      if (ok) await Promise.all([detail.refresh(), listing.refresh()]);
                    },
                  )
                }
                onSendDraft={async (text, settle) => {
                  const replyTo = draftReply?.replyTo ?? null;
                  const conversation = {
                    channelId: delegation.channelId,
                    id: delegation.conversationId,
                  };
                  const people =
                    channel.capabilities.includes("mentions") && text.includes("@")
                      ? [
                          ...((await readMentionable(environmentId, conversation)) ?? []),
                          ...(replyTo?.mention ? [replyTo.mention] : []),
                        ]
                      : [];
                  const failure = await sendReply(environmentId, {
                    conversation,
                    text,
                    replyTo,
                    // An edited draft still answers for its delegation; the copy records the edit.
                    delegationId: delegation.id,
                    markdown: channel.capabilities.includes("markdown"),
                    people,
                    attachments: [],
                  });
                  if (failure === null) {
                    if (settle) await settleDelegation(environmentId, delegation, true);
                    await Promise.all([detail.refresh(), listing.refresh()]);
                  }
                  return failure;
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

/** Where the conversation and an open follow-up both fit side by side (the `@5xl` breakpoint). */
const WIDE_INBOX_PX = 1024;

/**
 * What waits on you comes first, then the rest, each in the chat app's order. The held
 * conversation keeps its place while it is open. A heading names each group once there are two.
 */
function listItemsFor(
  conversations: ReadonlyArray<InboxConversation>,
  followUpsOf: (conversationId: string) => ReadonlyArray<InboxDelegation>,
  heldId: string | null,
  blockedThreadIds: ReadonlySet<string>,
): ReadonlyArray<ConversationListItem> {
  const top: ConversationListItem[] = [];
  const rest: ConversationListItem[] = [];
  for (const conversation of conversations) {
    const followUps = followUpsOf(conversation.id);
    const item = {
      type: "conversation" as const,
      conversation,
      followUp: topFollowUp(followUps, blockedThreadIds),
    };
    if (conversation.id === heldId || needsYou(conversation, followUps, blockedThreadIds)) {
      top.push(item);
    } else rest.push(item);
  }
  if (top.length === 0 || rest.length === 0) return [...top, ...rest];
  return [
    { type: "section", label: "Needs you" },
    ...top,
    { type: "section", label: "Others" },
    ...rest,
  ];
}

/** The delegation's draft as it would go out, and the message it answers. */
function draftReplyOf(
  detail: DelegationDetail | null | undefined,
  delegation: InboxDelegation | null,
  capabilities: ReadonlyArray<string>,
): { readonly text: string; readonly replyTo: ReplyTarget | null } | null {
  const draft = detail?.draft?.trim() ?? "";
  if (detail == null || delegation === null || detail.delegation.id !== delegation.id) return null;
  if (draft.length === 0) return null;
  const replyTo = draftReplyTarget(detail, delegation, capabilities);
  return { text: namedInReply(capabilities.includes("mentions"), replyTo, draft), replyTo };
}

/** A message's draft answers that message; a range's or a DM's is a new message. */
function draftReplyTarget(
  detail: DelegationDetail,
  delegation: InboxDelegation,
  capabilities: ReadonlyArray<string>,
): ReplyTarget | null {
  const kind = detail.conversation.kind;
  const answers =
    kind !== "dm" && delegation.scope !== "range"
      ? detail.messages.find((message) => message.id === delegation.anchorMessageId)
      : undefined;
  if (answers === undefined) return null;
  const modes = replyModes(kind, answers, capabilities.includes("quotes"));
  return replyTargetOf(
    kind,
    answers,
    modes,
    modes === null ? null : draftReplyMode(modes, answers, detail.messages),
  );
}

function DelegationActions({
  detail,
  settled,
  readOnly,
  onOpenThread,
  onDelegateAgain,
  onSettle,
}: {
  readonly detail: DelegationDetail;
  readonly settled: boolean;
  readonly readOnly: boolean;
  readonly onOpenThread: (threadId: string) => void;
  readonly onDelegateAgain: (target: DelegateTarget) => void;
  readonly onSettle: (settled: boolean) => void;
}) {
  const anchor = detail.messages.find(
    (message) => message.id === detail.delegation.anchorMessageId,
  );
  const thread = detail.delegation.thread;
  return (
    <>
      {settled ? (
        <IconAction label="Un-settle" onClick={() => onSettle(false)}>
          <Undo2Icon />
        </IconAction>
      ) : (
        <IconAction label="Settle" onClick={() => onSettle(true)}>
          <CircleCheckIcon />
        </IconAction>
      )}
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="ghost-muted" aria-label="Delegation actions" />}
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {thread && thread.status !== "deleted" ? (
            <MenuItem onClick={() => onOpenThread(thread.threadId)}>
              <ExternalLinkIcon />
              Open thread
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => void copyDelegationContext(detail)}>
            <CopyIcon />
            Copy the messages
          </MenuItem>
          <MenuItem
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
            Delegate again…
          </MenuItem>
        </MenuPopup>
      </Menu>
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
