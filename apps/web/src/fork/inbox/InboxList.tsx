import { LegendList } from "@legendapp/list/react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  BellOffIcon,
  BotIcon,
  EllipsisIcon,
  MailIcon,
  MailOpenIcon,
  MessagesSquareIcon,
  UserIcon,
  UsersIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import type { ConversationKind, InboxConversation, InboxDelegation } from "../types";
import {
  agoLabel,
  delegationPreview,
  lastMessageLine,
  minuteToMs,
  nameOrUnknown,
  type AgentSignals,
} from "./inboxView";
import { ThreadStatus } from "./DelegationPane";

const KIND_ICONS: Readonly<
  Record<ConversationKind, { readonly icon: LucideIcon; readonly label: string }>
> = {
  dm: { icon: UserIcon, label: "Direct message" },
  group: { icon: UsersIcon, label: "Group" },
  topic_group: { icon: MessagesSquareIcon, label: "Topic group" },
};

function ConversationKindIcon({ kind }: { readonly kind: ConversationKind }) {
  const { icon: Icon, label } = KIND_ICONS[kind];
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label={label} />;
}

export interface ConversationHandlers {
  readonly onSelect: (conversation: InboxConversation) => void;
  readonly onSetRead: (conversation: InboxConversation, read: boolean) => void;
  readonly onDiscardDrafts: (conversation: InboxConversation) => void;
}

const SWIPE_REVEAL = 68;
const SWIPE_THRESHOLD = 40;

export function ConversationMenu({
  conversation,
  drafts,
  onSetRead,
  onDiscardDrafts,
}: {
  readonly conversation: InboxConversation;
  /** How many of its delegations hold a draft reply. */
  readonly drafts: number;
  readonly onSetRead: ConversationHandlers["onSetRead"];
  readonly onDiscardDrafts: ConversationHandlers["onDiscardDrafts"];
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Conversation actions"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {conversation.unread ? (
          <MenuItem onClick={() => onSetRead(conversation, true)}>
            <MailOpenIcon />
            Mark read
          </MenuItem>
        ) : (
          <MenuItem onClick={() => onSetRead(conversation, false)}>
            <MailIcon />
            Mark unread
          </MenuItem>
        )}
        {drafts > 0 ? (
          <MenuItem onClick={() => onDiscardDrafts(conversation)}>
            <Trash2Icon />
            {drafts === 1 ? "Discard draft" : `Discard ${drafts} drafts`}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** The agent's state on a conversation row: unseen results first, then drafts, then threads. */
export function AgentBadge({ signals }: { readonly signals: AgentSignals | undefined }) {
  if (signals === undefined || signals.live === 0) return null;
  const label =
    signals.unseen > 0
      ? `${signals.unseen} new ${signals.unseen === 1 ? "result" : "results"}`
      : signals.drafts > 0
        ? `${signals.drafts} ${signals.drafts === 1 ? "draft" : "drafts"}`
        : `${signals.live} ${signals.live === 1 ? "delegation" : "delegations"}`;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1",
        signals.unseen > 0
          ? "text-primary"
          : signals.drafts > 0
            ? "text-success"
            : "text-muted-foreground",
      )}
    >
      <BotIcon className="size-3.5" />
      {label}
    </span>
  );
}

function ConversationRow({
  conversation,
  agent,
  now,
  selected,
  handlers,
}: {
  readonly conversation: InboxConversation;
  readonly agent: AgentSignals | undefined;
  readonly now: number;
  readonly selected: boolean;
  readonly handlers: ConversationHandlers;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; base: number; horizontal: boolean | null } | null>(
    null,
  );
  const swiped = offset !== 0;
  // Reading in T3 does not reach the chat app, so its badge counts only while T3 shows unread.
  const badge = conversation.unread ? (conversation.unreadCount ?? 0) : 0;
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    drag.current = { x: event.clientX, y: event.clientY, base: offset, horizontal: null };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.horizontal === null && Math.abs(dx) + Math.abs(dy) > 8) {
      current.horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (current.horizontal) setOffset(Math.min(0, Math.max(-SWIPE_REVEAL, current.base + dx)));
  };
  const onPointerEnd = () => {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    if (!current?.horizontal) return;
    setOffset((value) => (value < -SWIPE_THRESHOLD ? -SWIPE_REVEAL : 0));
  };

  return (
    <div className="relative mx-1.5 overflow-hidden rounded-md">
      <div
        className={cn("absolute inset-y-0 right-0 flex", !swiped && !dragging && "invisible")}
        aria-hidden={!swiped}
      >
        <button
          type="button"
          tabIndex={swiped ? 0 : -1}
          className="w-[68px] bg-primary text-xs font-medium text-primary-foreground"
          onClick={() => {
            setOffset(0);
            handlers.onSetRead(conversation, !conversation.unread);
          }}
        >
          {conversation.unread ? "Read" : "Unread"}
        </button>
      </div>
      <div
        className={cn(
          "group/row relative flex min-w-0 touch-pan-y items-start gap-1.5 py-2 pr-2.5 pl-1",
          selected ? "bg-accent" : "bg-background pointer-fine:hover:bg-accent/50",
          !dragging && "motion-safe:transition-transform motion-safe:duration-150",
        )}
        style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <span
          className={cn(
            "mt-[7px] size-1.5 shrink-0 rounded-full",
            !conversation.unread
              ? "bg-transparent"
              : conversation.muted
                ? "bg-muted-foreground/50"
                : "bg-primary",
          )}
          role={conversation.unread ? "img" : undefined}
          aria-label={conversation.unread ? "Unread" : undefined}
        />
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          aria-current={selected ? "true" : undefined}
          onClick={() => {
            if (swiped) {
              setOffset(0);
              return;
            }
            handlers.onSelect(conversation);
          }}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
              <ConversationKindIcon kind={conversation.kind} />
              <span className="truncate">{nameOrUnknown(conversation.name)}</span>
            </span>
            <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums pointer-fine:group-focus-within/row:invisible pointer-fine:group-hover/row:invisible pointer-fine:group-has-data-popup-open/row:invisible">
              {agoLabel(conversation.lastActivityAt, now)}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {conversation.mentioned ? (
                <span className="font-medium text-primary">[@you] </span>
              ) : null}
              {lastMessageLine(conversation)}
            </span>
            <AgentBadge signals={agent} />
            {badge > 0 ? (
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-3xs leading-4 font-medium tabular-nums",
                  conversation.muted
                    ? "bg-muted-foreground/20 text-muted-foreground"
                    : "bg-primary text-primary-foreground",
                )}
                aria-label={`${badge} unread`}
              >
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
            {conversation.muted ? (
              <BellOffIcon
                className="size-3.5 shrink-0 text-muted-foreground/70"
                aria-label="Muted"
              />
            ) : null}
          </span>
        </button>
        {/* Takes the time's place on hover; touch has the swipe and the conversation's own menu. */}
        <div className="invisible absolute end-1.5 top-1.5 group-focus-within/row:visible group-hover/row:visible has-data-popup-open:visible pointer-coarse:hidden">
          <ConversationMenu
            conversation={conversation}
            drafts={agent?.drafts ?? 0}
            onSetRead={handlers.onSetRead}
            onDiscardDrafts={handlers.onDiscardDrafts}
          />
        </div>
      </div>
    </div>
  );
}

export function ConversationList({
  conversations,
  agentSignals,
  selectedId,
  handlers,
}: {
  readonly conversations: ReadonlyArray<InboxConversation>;
  readonly agentSignals: ReadonlyMap<string, AgentSignals>;
  readonly selectedId: string | null;
  readonly handlers: ConversationHandlers;
}) {
  const now = minuteToMs(useNowMinute());
  // New activity lands on top: a reader at the top sees it, one further down keeps their place.
  const [scrolledDown, setScrolledDown] = useState(false);
  return (
    <LegendList<InboxConversation>
      data={conversations}
      keyExtractor={(conversation) => conversation.id}
      extraData={{ selectedId, now, handlers, agentSignals }}
      renderItem={({ item }) => (
        <ConversationRow
          conversation={item}
          agent={agentSignals.get(item.id)}
          now={now}
          selected={item.id === selectedId}
          handlers={handlers}
        />
      )}
      maintainVisibleContentPosition={{ data: scrolledDown }}
      onScroll={(event) => setScrolledDown(event.nativeEvent.contentOffset.y > 0)}
      estimatedItemSize={56}
      drawDistance={600}
      className="min-h-0 flex-1 overscroll-contain"
    />
  );
}

/** Where a delegation is: what it was about, where, and its thread. */
export function DelegationList({
  environmentId,
  delegations,
  kindOf,
  selectedId,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly delegations: ReadonlyArray<InboxDelegation>;
  /** The kind of each listed conversation; one the channel no longer lists has none. */
  readonly kindOf: ReadonlyMap<string, ConversationKind>;
  readonly selectedId: string | null;
  readonly onSelect: (delegation: InboxDelegation) => void;
}) {
  const now = minuteToMs(useNowMinute());
  return (
    <LegendList<InboxDelegation>
      data={delegations}
      keyExtractor={(delegation) => delegation.id}
      extraData={{ selectedId, now, kindOf }}
      renderItem={({ item }) => {
        const live = item.thread !== null && item.thread.detachedAt === null ? item.thread : null;
        return (
          <button
            type="button"
            className={cn(
              "mx-1.5 flex w-[calc(100%-0.75rem)] min-w-0 items-start gap-1.5 rounded-md py-2 pr-2.5 pl-1 text-left",
              item.id === selectedId ? "bg-accent" : "pointer-fine:hover:bg-accent/50",
            )}
            aria-current={item.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(item)}
          >
            <span
              className={cn(
                "mt-[7px] size-1.5 shrink-0 rounded-full",
                item.agentUnseen ? "bg-primary" : "bg-transparent",
              )}
              role={item.agentUnseen ? "img" : undefined}
              aria-label={item.agentUnseen ? "New result" : undefined}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
                  {kindOf.has(item.conversationId) ? (
                    <ConversationKindIcon kind={kindOf.get(item.conversationId)!} />
                  ) : null}
                  <span className="truncate">{nameOrUnknown(item.conversationName)}</span>
                </span>
                <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                  {agoLabel(item.thread?.runCompletedAt ?? item.createdAt, now)}
                </span>
              </span>
              <span className="flex min-w-0 items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {delegationPreview(
                    item.conversationName,
                    item.preview,
                    item.thread?.title ?? null,
                  )}
                </span>
                {live ? (
                  <ThreadStatus
                    environmentId={environmentId}
                    thread={live}
                    fallback={<DelegationOutcome delegation={item} />}
                  />
                ) : (
                  <DelegationOutcome delegation={item} />
                )}
              </span>
            </span>
          </button>
        );
      }}
      estimatedItemSize={56}
      drawDistance={600}
      className="min-h-0 flex-1 overscroll-contain"
    />
  );
}

/** What a finished delegation left for the user: a draft to send, or the reply already sent. */
export function DelegationOutcome({
  delegation,
  idle = null,
}: {
  readonly delegation: Pick<InboxDelegation, "hasDraft" | "lastSentAt">;
  /** Shown when it left neither. */
  readonly idle?: string | null;
}) {
  if (delegation.hasDraft) return <span className="shrink-0 text-success">Draft</span>;
  const label = delegation.lastSentAt !== null ? "Replied" : idle;
  return label === null ? null : <span className="shrink-0 text-muted-foreground">{label}</span>;
}
