import { LegendList } from "@legendapp/list/react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  BellOffIcon,
  BotIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  EllipsisIcon,
  MessagesSquareIcon,
  PencilLineIcon,
  UserIcon,
  UsersIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { UnreadCount } from "../presentation";
import type { ConversationKind, InboxConversation, InboxDelegation } from "../types";
import { agoLabel, lastMessageLine, minuteToMs, nameOrUnknown } from "./inboxView";
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
}

// Rows sit 8px in from both edges, as the toolbar does; the scrollbar lane is always reserved.
const LIST_CLASS = "min-h-0 flex-1 overscroll-contain [scrollbar-gutter:stable]";

/** The open conversation's menu also discards its delegations' drafts. */
export function ConversationMenu({
  conversation,
  drafts = 0,
  onDiscardDrafts,
}: {
  readonly conversation: InboxConversation;
  /** How many of its delegations hold a draft reply. */
  readonly drafts?: number;
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
        <MenuItem onClick={() => void copyConversationId(conversation)}>
          <CopyIcon />
          Copy chat ID
        </MenuItem>
        {drafts > 0 && onDiscardDrafts ? (
          <MenuItem onClick={() => onDiscardDrafts(conversation)}>
            <Trash2Icon />
            {drafts === 1 ? "Discard draft" : `Discard ${drafts} drafts`}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * A follow-up's state as the sidebar words a thread: its live status, else what it left. With
 * `onlyNeedsYou` (list rows, the conversation header) it shows only what waits on the user, so
 * work in progress and finished work stay in the chat's marker and the thread itself.
 */
export function FollowUpStatus({
  environmentId,
  delegation,
  idle = null,
  onlyNeedsYou = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly delegation: InboxDelegation;
  readonly idle?: string | null;
  readonly onlyNeedsYou?: boolean;
}) {
  const live =
    delegation.thread !== null && delegation.thread.detachedAt === null ? delegation.thread : null;
  const outcome = (
    <DelegationOutcome delegation={delegation} idle={idle} onlyNeedsYou={onlyNeedsYou} />
  );
  return live && delegation.settledAt === null ? (
    <ThreadStatus
      environmentId={environmentId}
      thread={live}
      fallback={outcome}
      onlyNeedsYou={onlyNeedsYou}
    />
  ) : (
    outcome
  );
}

function ConversationRow({
  environmentId,
  conversation,
  followUp,
  now,
  selected,
  handlers,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly followUp: InboxDelegation | undefined;
  readonly now: number;
  readonly selected: boolean;
  readonly handlers: ConversationHandlers;
}) {
  // One mark, always a number: an unknown count is at least one, as the Unread tab counts it.
  const badge = conversation.unread ? Math.max(conversation.unreadCount ?? 1, 1) : 0;
  return (
    <div className="relative ms-2 me-0.5 overflow-hidden rounded-md">
      <div
        className={cn(
          "group/row relative flex min-w-0 items-start px-2.5 py-2",
          selected ? "bg-accent" : "bg-background pointer-fine:hover:bg-accent/50",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
          aria-current={selected ? "true" : undefined}
          onClick={() => handlers.onSelect(conversation)}
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
              <FollowUpStatus environmentId={environmentId} delegation={followUp} onlyNeedsYou />
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
        {/* Takes the time's place on hover; touch has the open conversation's menu. */}
        <div className="invisible absolute end-1.5 top-1.5 group-focus-within/row:visible group-hover/row:visible has-data-popup-open:visible pointer-coarse:hidden">
          <ConversationMenu conversation={conversation} />
        </div>
      </div>
    </div>
  );
}

export type ConversationListItem =
  | { readonly type: "section"; readonly label: string }
  | {
      readonly type: "conversation";
      readonly conversation: InboxConversation;
      /** The follow-up the row shows: one that waits on you, else the newest open one. */
      readonly followUp: InboxDelegation | undefined;
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
        item.type === "section" ? `section:${item.label}` : item.conversation.id
      }
      getItemType={(item) => item.type}
      extraData={{ selectedId, now, handlers }}
      renderItem={({ item }) =>
        item.type === "section" ? (
          <p className="px-4.5 pt-3 pb-1 text-xs text-muted-foreground">{item.label}</p>
        ) : (
          <ConversationRow
            environmentId={environmentId}
            conversation={item.conversation}
            followUp={item.followUp}
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

/**
 * What a finished delegation left for the user: a draft to send, a result not yet seen (Done, as
 * the sidebar marks an unread thread), or, unless only what needs you is asked for, the reply
 * already sent or its settling.
 */
function DelegationOutcome({
  delegation,
  idle = null,
  onlyNeedsYou,
}: {
  readonly delegation: Pick<
    InboxDelegation,
    "agentUnseen" | "hasDraft" | "lastSentAt" | "settledAt"
  >;
  /** Shown when it left nothing else to show. */
  readonly idle?: string | null;
  readonly onlyNeedsYou: boolean;
}) {
  const idleLabel =
    idle === null ? null : (
      <StatusLabel icon={BotIcon} label={idle} className="text-muted-foreground" />
    );
  if (delegation.settledAt !== null) {
    return onlyNeedsYou ? (
      idleLabel
    ) : (
      <StatusLabel icon={CircleCheckIcon} label="Settled" className="text-muted-foreground" />
    );
  }
  if (delegation.hasDraft) {
    return <StatusLabel icon={PencilLineIcon} label="Draft" className="text-success" />;
  }
  if (delegation.agentUnseen) {
    return <StatusLabel icon={CircleCheckIcon} label="Done" className="text-success-foreground" />;
  }
  if (!onlyNeedsYou && delegation.lastSentAt !== null) {
    return <StatusLabel icon={CheckIcon} label="Replied" className="text-muted-foreground" />;
  }
  return idleLabel;
}
