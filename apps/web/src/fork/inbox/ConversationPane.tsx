import type { EnvironmentId } from "@t3tools/contracts";
import { BotIcon, CopyIcon, ExternalLinkIcon, MailIcon, MailOpenIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { Button } from "../../components/ui/button";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { forkRequest } from "../forkApiAccess";
import type { ConversationResponse, InboxItem } from "../types";
import { useForkResource, type ForkRefreshFilter } from "../useForkResource";
import {
  conversationRows,
  mergeConversationPages,
  nameOrUnknown,
  skippedNotice,
  type OlderPages,
} from "./inboxView";
import { copyItemContext, openItemInApp } from "./itemActions";
import { MessageView } from "./MessageView";

interface TopicHandlers {
  readonly onSelect: (item: InboxItem) => void;
  readonly onDelegate: (item: InboxItem) => void;
  readonly onSetRead: (item: InboxItem, read: boolean) => void;
}

/** Older messages load once the reader scrolls this close to the top. */
const LOAD_OLDER_PX = 200;
const AT_BOTTOM_PX = 24;
/** How many older pages to read looking for a selected topic before giving up. */
const FIND_SELECTED_PAGES = 5;

const isAtBottom = (container: HTMLElement) =>
  container.scrollHeight - container.scrollTop - container.clientHeight < AT_BOTTOM_PX;

/** The selected topic's conversation as a chat. Reads nothing while the layout hides it. */
export function ConversationPane({
  environmentId,
  selected,
  items,
  readOnly,
  handlers,
  refreshOn,
}: {
  readonly environmentId: EnvironmentId;
  readonly selected: InboxItem;
  readonly items: ReadonlyArray<InboxItem>;
  readonly readOnly: boolean;
  readonly handlers: TopicHandlers;
  readonly refreshOn: ForkRefreshFilter;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const shown = useShown(sectionRef);
  return (
    <section
      ref={sectionRef}
      aria-label="Conversation"
      className="hidden min-h-0 min-w-0 flex-1 flex-col @5xl/inbox:flex"
    >
      <h2 className="shrink-0 border-b px-4 py-2 text-xs font-medium">
        {nameOrUnknown(selected.conversationName)}
      </h2>
      {shown ? (
        <ConversationMessages
          key={`${selected.channelId}\u0000${selected.conversationId}`}
          environmentId={environmentId}
          selected={selected}
          items={items}
          readOnly={readOnly}
          handlers={handlers}
          refreshOn={refreshOn}
        />
      ) : null}
    </section>
  );
}

function useShown(ref: RefObject<HTMLElement | null>): boolean {
  const [shown, setShown] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a container query hides the pane; only layout knows whether it shows
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    return observeResize(element, ([entry]) => setShown((entry?.contentRect.width ?? 0) > 0));
  }, [ref]);
  return shown;
}

function ConversationMessages({
  environmentId,
  selected,
  items,
  readOnly,
  handlers,
  refreshOn,
}: {
  readonly environmentId: EnvironmentId;
  readonly selected: InboxItem;
  readonly items: ReadonlyArray<InboxItem>;
  readonly readOnly: boolean;
  readonly handlers: TopicHandlers;
  readonly refreshOn: ForkRefreshFilter;
}) {
  const { channelId, conversationId, conversationKind: kind } = selected;
  const path = `/inbox/conversation?${new URLSearchParams({ channelId, conversationId }).toString()}`;
  const newest = useForkResource<ConversationResponse>(environmentId, path, refreshOn);
  const [older, setOlder] = useState<OlderPages | null>(null);
  const [olderStatus, setOlderStatus] = useState<{
    readonly loading: boolean;
    readonly error: string | null;
  }>({ loading: false, error: null });
  const loadingOlder = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Distance from the bottom to keep while older messages are added above.
  const restoreFromBottom = useRef<number | null>(null);
  const atBottom = useRef(true);

  const merged = newest.data ? mergeConversationPages(newest.data, older) : null;
  const rows = merged
    ? conversationRows(
        merged.messages,
        items.filter(
          (item) => item.channelId === channelId && item.conversationId === conversationId,
        ),
        kind,
      )
    : [];
  const loaded = merged !== null;

  const loadOlder = async () => {
    const cursor = merged?.nextCursor ?? null;
    const joinId = merged?.older?.joinId ?? newest.data?.messages[0]?.id;
    if (cursor === null || joinId === undefined || loadingOlder.current) return;
    const base = merged?.older?.messages ?? [];
    loadingOlder.current = true;
    setOlderStatus({ loading: true, error: null });
    try {
      const page = await forkRequest<ConversationResponse>(
        environmentId,
        `${path}&${new URLSearchParams({ cursor }).toString()}`,
      );
      const container = scrollRef.current;
      restoreFromBottom.current =
        container === null ? null : container.scrollHeight - container.scrollTop;
      const known = new Set(base.map((message) => message.id));
      setOlder({
        messages: [...page.messages.filter((message) => !known.has(message.id)), ...base],
        nextCursor: page.nextCursor,
        joinId,
      });
      setOlderStatus({ loading: false, error: null });
    } catch (cause) {
      setOlderStatus({
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      loadingOlder.current = false;
    }
  };

  // Runs after every render: it keeps the reader's place as older messages land above, and a
  // reader at the bottom there as new ones arrive.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- adjusts the DOM's scroll position to content React just laid out
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container === null) return;
    if (restoreFromBottom.current !== null) {
      container.scrollTop = container.scrollHeight - restoreFromBottom.current;
      restoreFromBottom.current = null;
    } else if (atBottom.current) {
      container.scrollTop = container.scrollHeight;
    }
  });

  // The selected topic may be older than the pages read; read back a few pages to find it.
  const selectedShown = rows.some((row) => row.anchor && row.item?.id === selected.id);
  const searched = useRef({ id: selected.id, pages: 0 });
  const canSearch =
    loaded &&
    !selectedShown &&
    merged.nextCursor !== null &&
    !olderStatus.loading &&
    olderStatus.error === null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads older pages from the server until the selected topic is among them
  useEffect(() => {
    if (!canSearch) return;
    if (searched.current.id !== selected.id) searched.current = { id: selected.id, pages: 0 };
    if (searched.current.pages >= FIND_SELECTED_PAGES) return;
    searched.current.pages += 1;
    void loadOlder();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM to the newly selected topic; refreshes must not pull a reader away
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || !loaded) return;
    const target = selectedShown
      ? container.querySelector(`[data-item-id="${CSS.escape(selected.id)}"]`)
      : null;
    if (target) target.scrollIntoView({ block: "nearest" });
    else container.scrollTop = container.scrollHeight;
    atBottom.current = isAtBottom(container);
  }, [selected.id, loaded, selectedShown]);

  if (merged === null) {
    return (
      <p
        className={cn(
          "p-4 text-sm",
          newest.error ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {newest.error ? newest.error.message : "Loading…"}
      </p>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(event) => {
        const container = event.currentTarget;
        atBottom.current = isAtBottom(container);
        if (container.scrollTop < LOAD_OLDER_PX && !olderStatus.error) void loadOlder();
      }}
    >
      {merged.nextCursor !== null ? (
        <div className="flex justify-center pt-3">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={olderStatus.loading}
            onClick={() => void loadOlder()}
          >
            {olderStatus.loading
              ? "Loading…"
              : olderStatus.error
                ? "Could not load earlier messages; retry"
                : "Load earlier messages"}
          </Button>
        </div>
      ) : null}
      {newest.data && skippedNotice(newest.data.skipped) ? (
        <p className="px-4 pt-3 text-xs text-warning">{skippedNotice(newest.data.skipped)}</p>
      ) : null}
      <ol className="flex flex-col gap-3 px-3 py-3">
        {rows.map((row, index) => {
          const item = row.item;
          const decorated = row.anchor && item !== null;
          const replies = kind === "topic_group" && decorated ? item.replyCount : 0;
          return (
            <li
              key={row.message.id}
              data-item-id={decorated ? item.id : undefined}
              className={cn(
                "group relative flex min-w-0 scroll-mt-4 flex-col rounded-lg px-1 py-1",
                decorated && item.id === selected.id && "bg-accent/40 ring-1 ring-primary/40",
              )}
              onClick={item ? () => handlers.onSelect(item) : undefined}
            >
              <MessageView
                environmentId={environmentId}
                channelId={channelId}
                message={row.message}
                showAuthor={rows[index - 1]?.message.author.id !== row.message.author.id}
                quote={row.quote}
              >
                {decorated && (replies > 0 || item.unread) ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {replies > 0 ? (
                      <button
                        type="button"
                        className="text-foreground underline-offset-2 hover:underline"
                        onClick={() => handlers.onSelect(item)}
                      >
                        {replies} {replies === 1 ? "reply" : "replies"}
                      </button>
                    ) : null}
                    {item.unread ? <span className="text-primary">Unread</span> : null}
                  </span>
                ) : null}
              </MessageView>
              {decorated ? (
                <TopicToolbar
                  environmentId={environmentId}
                  item={item}
                  readOnly={readOnly}
                  handlers={handlers}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TopicToolbar({
  environmentId,
  item,
  readOnly,
  handlers,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
  readonly readOnly: boolean;
  readonly handlers: TopicHandlers;
}) {
  return (
    // Its clicks act on the topic, not select it.
    <div
      className="absolute -top-3 right-2 z-10 hidden gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm group-focus-within:flex group-hover:flex"
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Delegate"
        disabled={readOnly}
        onClick={() => handlers.onDelegate(item)}
      >
        <BotIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={item.unread ? "Mark read" : "Mark unread"}
        onClick={() => handlers.onSetRead(item, !item.unread)}
      >
        {item.unread ? <MailOpenIcon /> : <MailIcon />}
      </Button>
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
  );
}
