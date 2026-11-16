import { LegendList } from "@legendapp/list/react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  BotIcon,
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  MailIcon,
  MailOpenIcon,
} from "lucide-react";
import { useRef, useState, type PointerEvent } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { cn } from "../../lib/utils";
import type { InboxItem } from "../types";
import { copyItemContext, openItemInApp } from "./itemActions";
import { useNowMinute } from "../../hooks/useNowMinute";
import { ThreadStatus } from "./TopicDetail";
import { isOverdue, itemMeta, minuteToMs, nameOrUnknown, waitLabel } from "./inboxView";

export interface ItemHandlers {
  readonly onSelect: (item: InboxItem) => void;
  readonly onDelegate: (item: InboxItem) => void;
  readonly onSetRead: (item: InboxItem, read: boolean) => void;
}

const SWIPE_REVEAL = 68;
const SWIPE_THRESHOLD = 40;

export function ItemMenu({
  environmentId,
  item,
  readOnly,
  onDelegate,
  onSetRead,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
  readonly readOnly: boolean;
  readonly onDelegate: (item: InboxItem) => void;
  readonly onSetRead: ItemHandlers["onSetRead"];
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Topic actions"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem disabled={readOnly} onClick={() => onDelegate(item)}>
          <BotIcon />
          Delegate…
        </MenuItem>
        {item.unread ? (
          <MenuItem onClick={() => onSetRead(item, true)}>
            <MailOpenIcon />
            Mark read
          </MenuItem>
        ) : (
          <MenuItem onClick={() => onSetRead(item, false)}>
            <MailIcon />
            Mark unread
          </MenuItem>
        )}
        <MenuItem onClick={() => void copyItemContext(environmentId, item)}>
          <CopyIcon />
          Copy context
        </MenuItem>
        <MenuItem onClick={() => void openItemInApp(environmentId, item)}>
          <ExternalLinkIcon />
          Open in app
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ItemRow({
  environmentId,
  item,
  now,
  selected,
  readOnly,
  handlers,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
  readonly now: number;
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly handlers: ItemHandlers;
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
  const live = item.thread !== null && item.thread.detachedAt === null ? item.thread : null;

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
            handlers.onSetRead(item, !item.unread);
          }}
        >
          {item.unread ? "Read" : "Unread"}
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
            item.unread ? "bg-primary" : "bg-transparent",
          )}
          role={item.unread ? "img" : undefined}
          aria-label={item.unread ? "Unread" : undefined}
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
            handlers.onSelect(item);
          }}
        >
          <span className="flex min-w-0 items-baseline gap-2 text-xs">
            <span className="min-w-0 truncate font-medium text-foreground">
              {nameOrUnknown(item.conversationName)}
            </span>
            <span
              className={cn(
                "ms-auto shrink-0 tabular-nums text-muted-foreground",
                isOverdue(item, now) && "font-medium text-warning",
              )}
            >
              {waitLabel(item, now)}
            </span>
          </span>
          <span className="line-clamp-2 text-sm break-words text-foreground/90">
            {item.preview}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs">
            {live ? <ThreadStatus environmentId={environmentId} thread={live} /> : null}
            {item.hasDraft ? <span className="shrink-0 text-success">Draft</span> : null}
            <span className="min-w-0 truncate text-muted-foreground">{itemMeta(item)}</span>
          </span>
        </button>
        <ItemMenu
          environmentId={environmentId}
          item={item}
          readOnly={readOnly}
          onDelegate={handlers.onDelegate}
          onSetRead={handlers.onSetRead}
        />
      </div>
    </div>
  );
}

export function InboxList({
  environmentId,
  items,
  selectedId,
  readOnly,
  handlers,
}: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<InboxItem>;
  readonly selectedId: string | null;
  readonly readOnly: boolean;
  readonly handlers: ItemHandlers;
}) {
  const now = minuteToMs(useNowMinute());
  // New topics land on top: a reader at the top sees them, one further down keeps their place.
  const [scrolledDown, setScrolledDown] = useState(false);
  // "All" can hold a thousand topics per conversation; only the rows in view are mounted.
  return (
    <LegendList<InboxItem>
      data={items}
      keyExtractor={(item) => item.id}
      extraData={{ selectedId, now, readOnly, handlers }}
      renderItem={({ item }) => (
        <ItemRow
          environmentId={environmentId}
          item={item}
          now={now}
          selected={item.id === selectedId}
          readOnly={readOnly}
          handlers={handlers}
        />
      )}
      maintainVisibleContentPosition={{ data: scrolledDown }}
      onScroll={(event) => setScrolledDown(event.nativeEvent.contentOffset.y > 0)}
      estimatedItemSize={78}
      drawDistance={600}
      className="min-h-0 flex-1 overscroll-contain"
    />
  );
}
