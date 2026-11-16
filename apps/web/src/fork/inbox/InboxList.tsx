import { LegendList } from "@legendapp/list/react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AtSignIcon, BotIcon, EllipsisIcon, MailIcon, MailOpenIcon } from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import type { InboxConversation, InboxDelegation } from "../types";
import {
  agoLabel,
  lastMessageLine,
  minuteToMs,
  nameOrUnknown,
  type AgentSignals,
} from "./inboxView";
import { ThreadStatus } from "./DelegationPane";

export interface ConversationHandlers {
  readonly onSelect: (conversation: InboxConversation) => void;
  readonly onSetRead: (conversation: InboxConversation, read: boolean) => void;
}

const SWIPE_REVEAL = 68;
const SWIPE_THRESHOLD = 40;

export function ConversationMenu({
  conversation,
  onSetRead,
}: {
  readonly conversation: InboxConversation;
  readonly onSetRead: ConversationHandlers["onSetRead"];
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
      </MenuPopup>
    </Menu>
  );
}

/** The agent's state on a conversation row: unseen results first, then drafts, then threads. */
function AgentBadge({ signals }: { readonly signals: AgentSignals | undefined }) {
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
      <BotIcon className="size-3" />
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
    <div className="relative overflow-hidden border-b border-border/50">
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
          "relative flex min-w-0 touch-pan-y items-start gap-2 bg-background py-2.5 pr-3 pl-1.5",
          selected && "bg-accent",
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
            "mt-1.5 size-1.5 shrink-0 rounded-full",
            conversation.unread ? "bg-primary" : "bg-transparent",
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
          <span className="flex min-w-0 items-baseline gap-2 text-xs">
            <span className="min-w-0 truncate font-medium text-foreground">
              {nameOrUnknown(conversation.name)}
            </span>
            <span className="ms-auto shrink-0 text-muted-foreground tabular-nums">
              {agoLabel(conversation.lastActivityAt, now)}
            </span>
          </span>
          <span className="line-clamp-2 text-sm break-words text-foreground/90">
            {lastMessageLine(conversation)}
          </span>
          {conversation.mentioned || (agent?.live ?? 0) > 0 ? (
            <span className="flex min-w-0 items-center gap-2 text-xs">
              {conversation.mentioned ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-warning">
                  <AtSignIcon className="size-3" />
                  Mentioned
                </span>
              ) : null}
              <AgentBadge signals={agent} />
            </span>
          ) : null}
        </button>
        <ConversationMenu conversation={conversation} onSetRead={handlers.onSetRead} />
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
      estimatedItemSize={72}
      drawDistance={600}
      className="min-h-0 flex-1 overscroll-contain"
    />
  );
}

/** Where a delegation is: what it was about, where, and its thread. */
export function DelegationList({
  environmentId,
  delegations,
  selectedId,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly delegations: ReadonlyArray<InboxDelegation>;
  readonly selectedId: string | null;
  readonly onSelect: (delegation: InboxDelegation) => void;
}) {
  const now = minuteToMs(useNowMinute());
  return (
    <LegendList<InboxDelegation>
      data={delegations}
      keyExtractor={(delegation) => delegation.id}
      extraData={{ selectedId, now }}
      renderItem={({ item }) => {
        const live = item.thread !== null && item.thread.detachedAt === null ? item.thread : null;
        return (
          <button
            type="button"
            className={cn(
              "flex w-full min-w-0 items-start gap-2 border-b border-border/50 py-2.5 pr-3 pl-1.5 text-left",
              item.id === selectedId && "bg-accent",
            )}
            aria-current={item.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(item)}
          >
            <span
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-full",
                item.agentUnseen ? "bg-primary" : "bg-transparent",
              )}
              role={item.agentUnseen ? "img" : undefined}
              aria-label={item.agentUnseen ? "New result" : undefined}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-baseline gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-foreground">
                  {nameOrUnknown(item.conversationName)}
                </span>
                <span className="ms-auto shrink-0 text-muted-foreground tabular-nums">
                  {agoLabel(item.thread?.runCompletedAt ?? item.createdAt, now)}
                </span>
              </span>
              <span className="line-clamp-2 text-sm break-words text-foreground/90">
                {item.preview ?? item.thread?.title ?? "Delegated messages"}
              </span>
              <span className="flex min-w-0 items-center gap-2 text-xs">
                {live ? <ThreadStatus environmentId={environmentId} thread={live} /> : null}
                {item.hasDraft ? <span className="shrink-0 text-success">Draft</span> : null}
                {item.hasConclusion ? (
                  <span className="shrink-0 text-muted-foreground">Conclusion</span>
                ) : null}
              </span>
            </span>
          </button>
        );
      }}
      estimatedItemSize={72}
      drawDistance={600}
      className="min-h-0 flex-1 overscroll-contain"
    />
  );
}
