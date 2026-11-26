import { LegendList } from "@legendapp/list/react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  BellOffIcon,
  BotIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  EllipsisIcon,
  MailIcon,
  MailOpenIcon,
  MessagesSquareIcon,
  PencilLineIcon,
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
import { UnreadCount } from "../presentation";
import type { ConversationKind, InboxConversation, InboxDelegation } from "../types";
import {
  ATTENTION_LABELS,
  agoLabel,
  lastMessageLine,
  minuteToMs,
  nameOrUnknown,
  topFollowUp,
  type Attention,
} from "./inboxView";
import { StatusLabel, ThreadStatus } from "./DelegationPane";
import { copyConversationId } from "./itemActions";

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
}

// Rows sit 8px in from both edges, as the toolbar does; the scrollbar lane is always reserved.
const LIST_CLASS = "min-h-0 flex-1 overscroll-contain [scrollbar-gutter:stable]";

const SWIPE_REVEAL = 68;
const SWIPE_THRESHOLD = 40;

/** Each place offers what fits its moment: the row triages, the open conversation acts on it. */
export function ConversationMenu({
  conversation,
  place,
  drafts = 0,
  onSetRead,
  onDiscardDrafts,
}: {
  readonly conversation: InboxConversation;
  readonly place: "row" | "header";
  /** How many of its delegations hold a draft reply. */
  readonly drafts?: number;
  readonly onSetRead?: ConversationHandlers["onSetRead"];
  readonly onDiscardDrafts?: (conversation: InboxConversation) => void;
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
        {place === "row" && onSetRead ? (
          conversation.unread ? (
            <MenuItem onClick={() => onSetRead(conversation, true)}>
              <MailOpenIcon />
              Mark read
            </MenuItem>
          ) : (
            <MenuItem onClick={() => onSetRead(conversation, false)}>
              <MailIcon />
              Mark unread
            </MenuItem>
          )
        ) : null}
        <MenuItem onClick={() => void copyConversationId(conversation)}>
          <CopyIcon />
          Copy chat ID
        </MenuItem>
        {place === "header" && drafts > 0 && onDiscardDrafts ? (
          <MenuItem onClick={() => onDiscardDrafts(conversation)}>
            <Trash2Icon />
            {drafts === 1 ? "Discard draft" : `Discard ${drafts} drafts`}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** A follow-up's state as the sidebar words a thread: its live status, else what it left. */
export function FollowUpStatus({
  environmentId,
  delegation,
  idle = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly delegation: InboxDelegation;
  readonly idle?: string | null;
}) {
  const live =
    delegation.thread !== null && delegation.thread.detachedAt === null ? delegation.thread : null;
  const outcome = <DelegationOutcome delegation={delegation} idle={idle} />;
  return live && delegation.settledAt === null ? (
    <ThreadStatus environmentId={environmentId} thread={live} fallback={outcome} />
  ) : (
    outcome
  );
}

function ConversationRow({
  environmentId,
  conversation,
  followUps,
  now,
  selected,
  handlers,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly followUps: ReadonlyArray<InboxDelegation>;
  readonly now: number;
  readonly selected: boolean;
  readonly handlers: ConversationHandlers;
}) {
  const followUp = topFollowUp(followUps);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; base: number; horizontal: boolean | null } | null>(
    null,
  );
  const swiped = offset !== 0;
  // One mark, always a number: an unknown count is at least one, as the Unread tab counts it.
  const badge = conversation.unread ? Math.max(conversation.unreadCount ?? 1, 1) : 0;
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
    <div className="relative ms-2 me-0.5 overflow-hidden rounded-md">
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
          "group/row relative flex min-w-0 touch-pan-y items-start px-2.5 py-2",
          selected ? "bg-accent" : "bg-background pointer-fine:hover:bg-accent/50",
          !dragging && "motion-safe:transition-transform motion-safe:duration-150",
        )}
        style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
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
            {followUp ? (
              <FollowUpStatus environmentId={environmentId} delegation={followUp} />
            ) : null}
            {badge > 0 ? <UnreadCount count={badge} muted={conversation.muted} /> : null}
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
            place="row"
            conversation={conversation}
            onSetRead={handlers.onSetRead}
          />
        </div>
      </div>
    </div>
  );
}

export type ConversationListItem =
  | { readonly type: "section"; readonly attention: Attention }
  | {
      readonly type: "conversation";
      readonly conversation: InboxConversation;
      readonly followUps: ReadonlyArray<InboxDelegation>;
    };

export function ConversationList({
  environmentId,
  items,
  selectedId,
  handlers,
}: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<ConversationListItem>;
  readonly selectedId: string | null;
  readonly handlers: ConversationHandlers;
}) {
  const now = minuteToMs(useNowMinute());
  // New activity lands on top: a reader at the top sees it, one further down keeps their place.
  const [scrolledDown, setScrolledDown] = useState(false);
  return (
    <LegendList<ConversationListItem>
      data={items}
      keyExtractor={(item) =>
        item.type === "section" ? `section:${item.attention}` : item.conversation.id
      }
      getItemType={(item) => item.type}
      extraData={{ selectedId, now, handlers }}
      renderItem={({ item }) =>
        item.type === "section" ? (
          <p className="px-4.5 pt-3 pb-1 text-xs text-muted-foreground">
            {ATTENTION_LABELS[item.attention]}
          </p>
        ) : (
          <ConversationRow
            environmentId={environmentId}
            conversation={item.conversation}
            followUps={item.followUps}
            now={now}
            selected={item.conversation.id === selectedId}
            handlers={handlers}
          />
        )
      }
      maintainVisibleContentPosition={{ data: scrolledDown }}
      onScroll={(event) => setScrolledDown(event.nativeEvent.contentOffset.y > 0)}
      estimatedItemSize={56}
      drawDistance={600}
      className={LIST_CLASS}
    />
  );
}

/** What a finished delegation left for the user: a draft to send, or the reply already sent. */
function DelegationOutcome({
  delegation,
  idle = null,
}: {
  readonly delegation: Pick<InboxDelegation, "hasDraft" | "lastSentAt" | "settledAt">;
  /** Shown when it left neither. */
  readonly idle?: string | null;
}) {
  if (delegation.settledAt !== null) {
    return <StatusLabel icon={CircleCheckIcon} label="Settled" className="text-muted-foreground" />;
  }
  if (delegation.hasDraft) {
    return <StatusLabel icon={PencilLineIcon} label="Draft" className="text-success" />;
  }
  if (delegation.lastSentAt !== null) {
    return <StatusLabel icon={CheckIcon} label="Replied" className="text-muted-foreground" />;
  }
  return idle === null ? null : (
    <StatusLabel icon={BotIcon} label={idle} className="text-muted-foreground" />
  );
}
