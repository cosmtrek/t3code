import type { EnvironmentId } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  BellOffIcon,
  BotIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  MessageSquareReplyIcon,
  PaperclipIcon,
  ReplyIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { forkRequest } from "../forkApiAccess";
import type {
  ConversationKind,
  ConversationResponse,
  InboxConversation,
  InboxDelegation,
  InboxMessage,
  Mention,
  Upload,
} from "../types";
import { useForkResource, type ForkRefreshFilter } from "../useForkResource";
import { ThreadStatus } from "./DelegationPane";
import { IconAction } from "./IconAction";
import { useFormatTimestamp } from "../presentation";
import { AgentBadge, ConversationMenu, DelegationOutcome } from "./InboxList";
import {
  agentSignalsFor,
  conversationRows,
  delegationPreview,
  mentionsIn,
  mentionSuggestions,
  mergeConversationPages,
  nameOrUnknown,
  quoteOfMessage,
  replyLine,
  replyModes,
  skippedNotice,
  topicsOf,
  withMention,
  withoutMention,
  type ConversationRow,
  type ReplyMode,
  type Topic,
  type OlderPages,
} from "./inboxView";
import { MessageView } from "./MessageView";
import { PaneHeader } from "./PaneHeader";
import { readMentionable, sendReply } from "./sendReply";
import { ReplyBox, useSendKey } from "./ReplyBox";
import { loadReply, replyDraftKey, saveReply } from "./replyDrafts";

export interface ConversationPaneHandlers {
  readonly onBack: () => void;
  readonly onSetRead: (conversation: InboxConversation, read: boolean) => void;
  readonly onDiscardDrafts: (conversation: InboxConversation) => void;
  readonly onSelectDelegation: (delegation: InboxDelegation) => void;
  /** Delegate starting at `message`; `later` is what the chat shows after it. */
  readonly onDelegate: (message: InboxMessage, later: ReadonlyArray<InboxMessage>) => void;
  /** The user acts in the conversation, such as starting a reply: what arrived since is read. */
  readonly onEngage: () => void;
}

/** What the reply box should hold; a new `nonce` replaces what it holds. */
interface ReplyRequest {
  readonly nonce: number;
  /** The conversation it is for; another conversation's reply box ignores it. */
  readonly conversationId: string;
  readonly replyTo: ReplyTarget | null;
}

export interface ReplyTarget {
  readonly messageId: string;
  readonly quote: string;
  /** Null for an adapter that places a reply itself. */
  readonly inThread: boolean | null;
  /** The chat app takes either a quote or a thread reply here. */
  readonly canSwitch: boolean;
  /** Whom a quote reply names, as the chat app does. */
  readonly mention: Mention | null;
}

/** A quote reply names whom it answers, as the chat app does. */
export function namedInReply(canMention: boolean, target: ReplyTarget | null, text: string) {
  return canMention && target?.inThread === false && target.mention !== null
    ? withMention(text, target.mention.name)
    : text;
}

export function replyTargetOf(
  kind: ConversationKind,
  message: InboxMessage,
  modes: ReadonlyArray<ReplyMode> | null,
  mode: ReplyMode | null,
): ReplyTarget {
  return {
    messageId: message.id,
    quote: quoteOfMessage(message),
    inThread: modes === null || mode === null ? null : mode === "thread",
    canSwitch: modes !== null && modes.length > 1,
    mention:
      kind === "dm" || message.author.isSelf
        ? null
        : { userId: message.author.id, name: message.author.name },
  };
}

/** A file picked for the reply; `uploadId` is null while it is on its way to the adapter. */
interface AttachedFile {
  readonly key: number;
  readonly name: string;
  readonly uploadId: string | null;
}

const MAX_ATTACHMENTS = 9;

let replyNonce = 0;
/** Tells one reply request, or one attached file, from the next. */
const nextReplyNonce = () => ++replyNonce;

/** Replies a folded topic shows under its post, as the chat app does. */
const FOLDED_REPLIES = 2;

/** Older messages load once the reader scrolls this close to the top. */
const LOAD_OLDER_PX = 200;
const AT_BOTTOM_PX = 24;
/** How many older pages to read looking for a delegation's first message before giving up. */
const FIND_FOCUS_PAGES = 5;
/** A same-author message this soon after the last one reads as its continuation. */
const CONTINUED_WITHIN_MS = 5 * 60_000;
/** A quiet spell this long gets a time line between messages, as the chat app draws it. */
const TIME_BREAK_MS = 60 * 60_000;
/** The jump to the newest message shows once the reader is this far above it. */
const JUMP_AFTER_PX = 400;

const isAtBottom = (container: HTMLElement) =>
  container.scrollHeight - container.scrollTop - container.clientHeight < AT_BOTTOM_PX;

/** The message at the top of the view and how far below the top it sat; null is the bottom. */
type Place = { readonly messageId: string; readonly offset: number } | null;
// The pane unmounts when the page is left or the narrow layout hides it; it comes back here.
const places = new Map<string, Place>();
const placeKey = (environmentId: string, channelId: string, conversationId: string) =>
  `${environmentId}\u0000${channelId}\u0000${conversationId}`;
/** Opening a conversation from the list starts at its new messages, not where it was left. */
export const forgetPlace = (environmentId: string, conversation: InboxConversation) =>
  places.delete(placeKey(environmentId, conversation.channelId, conversation.id));

function placeOf(container: HTMLElement): Place | undefined {
  if (isAtBottom(container)) return null;
  const box = container.getBoundingClientRect();
  // Probe a little way down in case the top edge falls in the gap between two messages.
  for (const dy of [1, 12, 24, 48]) {
    const hit = document
      .elementFromPoint(box.left + box.width / 2, box.top + dy)
      ?.closest<HTMLElement>("[data-message-id]");
    if (hit && container.contains(hit)) {
      return {
        messageId: hit.dataset.messageId!,
        offset: hit.getBoundingClientRect().top - box.top,
      };
    }
  }
  return undefined;
}

/** The conversation as a chat, with the reply box under it. */
export function ConversationPane({
  environmentId,
  conversation,
  delegations,
  selectedDelegationId,
  onCloseDelegation,
  focusMessageId,
  newSince,
  readOnly,
  capabilities,
  handlers,
  refreshOn,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly delegations: ReadonlyArray<InboxDelegation>;
  readonly selectedDelegationId: string | null;
  readonly onCloseDelegation: () => void;
  /** The selected delegation's first message, scrolled to and marked. */
  readonly focusMessageId: string | null;
  /** The read mark when the reader opened the conversation; what came after it is new. */
  readonly newSince: string | null;
  readonly readOnly: boolean;
  /** The optional parts of the protocol the channel's adapter implements. */
  readonly capabilities: ReadonlyArray<string>;
  readonly handlers: ConversationPaneHandlers;
  readonly refreshOn: ForkRefreshFilter;
  readonly className?: string;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const shown = useShown(sectionRef);
  const [request, setRequest] = useState<ReplyRequest | null>(null);
  const modesOf = (message: InboxMessage) =>
    replyModes(conversation.kind, message, capabilities.includes("quotes"));
  const replyTo = (message: InboxMessage, mode: ReplyMode | null) =>
    setRequest({
      nonce: nextReplyNonce(),
      conversationId: conversation.id,
      replyTo: replyTargetOf(conversation.kind, message, modesOf(message), mode),
    });
  return (
    <section
      ref={sectionRef}
      aria-label="Conversation"
      className={cn("min-h-0 min-w-0 flex-1 flex-col", className)}
    >
      <PaneHeader edge="detail">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Back to the list"
          className="@2xl/inbox:hidden"
          onClick={handlers.onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1">
          <h2 className="truncate text-sm font-medium">{nameOrUnknown(conversation.name)}</h2>
          {conversation.muted ? (
            <BellOffIcon
              className="size-3.5 shrink-0 text-muted-foreground/70"
              aria-label="Muted"
            />
          ) : null}
        </div>
        <ConversationDelegationsControl
          environmentId={environmentId}
          conversation={conversation}
          delegations={delegations}
          selectedDelegationId={selectedDelegationId}
          onSelect={handlers.onSelectDelegation}
          onClose={onCloseDelegation}
        />
        <ConversationMenu
          place="header"
          conversation={conversation}
          drafts={delegations.filter((delegation) => delegation.hasDraft).length}
          onDiscardDrafts={handlers.onDiscardDrafts}
        />
      </PaneHeader>
      {shown ? (
        <ConversationMessages
          key={`${conversation.channelId}\u0000${conversation.id}`}
          environmentId={environmentId}
          conversation={conversation}
          delegations={delegations}
          focusMessageId={focusMessageId}
          newSince={newSince}
          readOnly={readOnly}
          handlers={handlers}
          replyModesOf={modesOf}
          onReply={replyTo}
          refreshOn={refreshOn}
        />
      ) : (
        <div className="flex-1" />
      )}
      <Composer
        key={`composer\u0000${conversation.channelId}\u0000${conversation.id}`}
        environmentId={environmentId}
        conversation={conversation}
        request={request}
        disabled={readOnly}
        capabilities={capabilities}
        onEngage={handlers.onEngage}
      />
    </section>
  );
}

function ConversationDelegationsControl({
  environmentId,
  conversation,
  delegations,
  selectedDelegationId,
  onSelect,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly delegations: ReadonlyArray<InboxDelegation>;
  readonly selectedDelegationId: string | null;
  readonly onSelect: (delegation: InboxDelegation) => void;
  readonly onClose: () => void;
}) {
  if (delegations.length === 0) return null;
  const raw = agentSignalsFor(delegations);
  const signals = raw.live > 0 ? raw : { ...raw, live: delegations.length };
  const active = delegations.some((delegation) => delegation.id === selectedDelegationId);
  if (delegations.length === 1) {
    const only = delegations[0]!;
    return (
      <Button
        size="xs"
        variant="ghost"
        aria-pressed={active}
        data-pressed={active ? "" : undefined}
        onClick={() => (active ? onClose() : onSelect(only))}
      >
        <AgentBadge signals={signals} />
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost" data-pressed={active ? "" : undefined} />}
      >
        <AgentBadge signals={signals} />
      </MenuTrigger>
      <MenuPopup align="end">
        {delegations.map((delegation) => {
          const live =
            delegation.thread !== null && delegation.thread.detachedAt === null
              ? delegation.thread
              : null;
          return (
            <MenuItem key={delegation.id} onClick={() => onSelect(delegation)}>
              <span className="flex w-full max-w-72 min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {delegationPreview(
                    conversation.name,
                    delegation.preview,
                    delegation.thread?.title ?? null,
                  )}
                </span>
                {live ? (
                  <ThreadStatus
                    environmentId={environmentId}
                    thread={live}
                    fallback={<DelegationOutcome delegation={delegation} />}
                  />
                ) : (
                  <DelegationOutcome delegation={delegation} />
                )}
              </span>
            </MenuItem>
          );
        })}
      </MenuPopup>
    </Menu>
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
  conversation,
  delegations,
  focusMessageId,
  newSince,
  readOnly,
  handlers,
  replyModesOf,
  onReply,
  refreshOn,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly delegations: ReadonlyArray<InboxDelegation>;
  readonly focusMessageId: string | null;
  readonly newSince: string | null;
  readonly readOnly: boolean;
  readonly handlers: ConversationPaneHandlers;
  readonly replyModesOf: (message: InboxMessage) => ReadonlyArray<ReplyMode> | null;
  readonly onReply: (message: InboxMessage, mode: ReplyMode | null) => void;
  readonly refreshOn: ForkRefreshFilter;
}) {
  const path = `/inbox/conversation?${new URLSearchParams({
    channelId: conversation.channelId,
    conversationId: conversation.id,
  }).toString()}`;
  const newest = useForkResource<ConversationResponse>(environmentId, path, refreshOn);
  const formatTimestamp = useFormatTimestamp();
  const [older, setOlder] = useState<OlderPages | null>(null);
  const [olderStatus, setOlderStatus] = useState<{
    readonly loading: boolean;
    readonly error: string | null;
  }>({ loading: false, error: null });
  const loadingOlder = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const key = placeKey(environmentId, conversation.channelId, conversation.id);
  // Coming back to a conversation keeps the reader's place over the focus it was opened with.
  const restore = useRef<{ readonly place: Place | undefined; focus: string | null | undefined }>({
    place: places.get(key),
    focus: places.has(key) ? focusMessageId : undefined,
  });
  // Distance from the bottom to keep while older messages are added above.
  const restoreFromBottom = useRef<number | null>(null);
  const atBottom = useRef(true);
  /** Threads the reader opened, or closed after one opened by itself. */
  const [toggledThreads, setToggledThreads] = useState<ReadonlySet<string>>(new Set());
  const newLine = useRef<HTMLLIElement>(null);
  /** Scrolled away from the newest message, and whether the new ones are still below. */
  const [away, setAway] = useState<{ readonly far: boolean; readonly newBelow: boolean }>({
    far: false,
    newBelow: false,
  });

  const merged = newest.data ? mergeConversationPages(newest.data, older) : null;
  const rows = merged ? conversationRows(merged.messages, delegations) : [];
  const loaded = merged !== null;
  const firstNew =
    newSince === null
      ? -1
      : rows.findIndex(
          (row) =>
            !row.message.author.isSelf && Date.parse(row.message.createdAt) > Date.parse(newSince),
        );
  const newCount =
    firstNew === -1 ? 0 : rows.slice(firstNew).filter((row) => !row.message.author.isSelf).length;

  const loadOlder = async () => {
    const cursor = merged?.nextCursor ?? null;
    const joinId = merged?.older?.joinId ?? newest.data?.messages[0]?.id;
    if (cursor === null || joinId === undefined || loadingOlder.current) return;
    const base = merged?.older?.messages ?? [];
    loadingOlder.current = true;
    setOlderStatus({ loading: true, error: null });
    const page = await forkRequest<ConversationResponse>(
      environmentId,
      `${path}&${new URLSearchParams({ cursor }).toString()}`,
    ).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
    loadingOlder.current = false;
    if (typeof page === "string") {
      setOlderStatus({ loading: false, error: page });
      return;
    }
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

  // The focused message may be older than the pages read; read back a few pages to find it.
  const focusShown = rows.some(
    (row) =>
      row.message.id === focusMessageId ||
      row.thread.some((reply) => reply.message.id === focusMessageId),
  );
  const searched = useRef({ id: focusMessageId, pages: 0 });
  const canSearch =
    loaded &&
    focusMessageId !== null &&
    !focusShown &&
    merged.nextCursor !== null &&
    !olderStatus.loading &&
    olderStatus.error === null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads older pages from the server until the focused message is among them
  useEffect(() => {
    if (!canSearch) return;
    if (searched.current.id !== focusMessageId) {
      searched.current = { id: focusMessageId, pages: 0 };
    }
    if (searched.current.pages >= FIND_FOCUS_PAGES) return;
    searched.current.pages += 1;
    void loadOlder();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM to the newly focused message; refreshes must not pull a reader away
  useEffect(() => {
    const container = scrollRef.current;
    if (container === null || !loaded) return;
    const { place } = restore.current;
    restore.current = { place: undefined, focus: restore.current.focus };
    if (place !== undefined) {
      const anchor =
        place === null
          ? null
          : container.querySelector(`[data-message-id="${CSS.escape(place.messageId)}"]`);
      if (place === null) container.scrollTop = container.scrollHeight;
      else if (anchor) {
        container.scrollTop +=
          anchor.getBoundingClientRect().top - container.getBoundingClientRect().top - place.offset;
      }
      if (place === null || anchor) {
        atBottom.current = isAtBottom(container);
        return;
      }
      // The message was on a page not read again; open as if new.
      restore.current.focus = undefined;
    }
    if (focusMessageId === restore.current.focus) return;
    restore.current.focus = undefined;
    const target =
      focusShown && focusMessageId !== null
        ? container.querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`)
        : null;
    if (target) target.scrollIntoView({ block: "nearest" });
    // Opens where the reader left off, as the chat app does.
    else if (focusMessageId === null && newLine.current) newLine.current.scrollIntoView();
    else container.scrollTop = container.scrollHeight;
    atBottom.current = isAtBottom(container);
  }, [focusMessageId, loaded, focusShown]);

  const toolbarFor = (row: ConversationRow, later: ReadonlyArray<ConversationRow>) => (
    <MessageToolbar
      message={row.message}
      readOnly={readOnly}
      replyModes={replyModesOf(row.message)}
      onReply={(mode) => onReply(row.message, mode)}
      onDelegate={() =>
        handlers.onDelegate(
          row.message,
          later.map((next) => next.message),
        )
      }
    />
  );
  const chipsFor = (row: ConversationRow) =>
    row.delegations.length > 0 ? (
      // The negative margin lines the ghost buttons' labels up with the bubble's edge.
      <span className="-mx-[calc(--spacing(2)-1px)] flex flex-wrap items-center gap-1 text-xs">
        {row.delegations.map((delegation) => (
          <DelegationChip
            key={delegation.id}
            environmentId={environmentId}
            delegation={delegation}
            onSelect={handlers.onSelectDelegation}
          />
        ))}
      </span>
    ) : null;
  const focusRing = (row: ConversationRow) => row.message.id === focusMessageId && "bg-primary/6";
  const isOpen = (id: string, replies: ReadonlyArray<ConversationRow>) => {
    const holdsFocus = replies.some((reply) => reply.message.id === focusMessageId);
    // A thread opens by itself for the message a delegation points at.
    return toggledThreads.has(id) ? !holdsFocus : holdsFocus;
  };
  const toggle = (id: string) =>
    setToggledThreads((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const item = (
    row: ConversationRow,
    previous: ConversationRow | undefined,
    later: ReadonlyArray<ConversationRow>,
    rootId: string | null = null,
  ) => {
    const sameAuthor = previous?.message.author.id === row.message.author.id;
    const continued =
      sameAuthor &&
      Date.parse(row.message.createdAt) - Date.parse(previous!.message.createdAt) <
        CONTINUED_WITHIN_MS;
    return (
      <li
        key={row.message.id}
        data-message-id={row.message.id}
        className={cn(
          // The negative margins take back the padding that gives the highlight room.
          "group/message relative -mx-2 -mb-1.5 flex min-w-0 scroll-mt-4 flex-col rounded-lg px-3 py-2",
          // Speakers part with a gap; one speaker's run stays tight.
          previous === undefined ? "-mt-1.5" : sameAuthor ? "-mt-1" : "mt-1.5",
          focusRing(row),
        )}
      >
        <MessageView
          environmentId={environmentId}
          channelId={conversation.channelId}
          message={row.message}
          showAuthor={!sameAuthor}
          continued={continued}
          inThread={rootId !== null}
          // Under its root, a reply to the root itself needs no quote.
          quote={rootId !== null && row.message.replyTo?.id === rootId ? null : row.quote}
          toolbar={toolbarFor(row, later)}
        >
          {chipsFor(row)}
        </MessageView>
      </li>
    );
  };

  /** A topic group's message: the post, or a reply inside it, with its actions at its corner. */
  const postBlock = (
    row: ConversationRow,
    later: ReadonlyArray<ConversationRow>,
    rootId: string | null,
  ) => (
    <div
      key={row.message.id}
      data-message-id={row.message.id}
      className={cn(
        // Padding the margin takes back gives the highlight room without moving the post.
        "group/message relative -m-2 flex min-w-0 scroll-mt-4 flex-col rounded-lg p-2",
        focusRing(row),
      )}
    >
      <MessageView
        layout="post"
        environmentId={environmentId}
        channelId={conversation.channelId}
        message={row.message}
        showAuthor
        // Inside a topic, a reply to the topic itself needs no quote.
        quote={row.message.replyTo?.id === rootId ? null : row.quote}
      >
        {chipsFor(row)}
      </MessageView>
      <div className="absolute top-0.5 end-2 z-10">{toolbarFor(row, later)}</div>
    </div>
  );

  /** A topic as the chat app shows it: the post, then its newest replies until opened. */
  const topic = ({ id, post, heading, replies }: Topic) => {
    const open = isOpen(id, replies);
    const folded = replies.slice(-FOLDED_REPLIES);
    // The adapter's count includes replies older than the pages read.
    const earlier = Math.max(post?.message.replyCount ?? 0, replies.length) - folded.length;
    return (
      <li key={id} className="flex min-w-0 flex-col gap-2 rounded-lg border border-border/60 p-3">
        {post ? (
          postBlock(post, replies, null)
        ) : (
          <p className="truncate text-xs text-muted-foreground">{heading ?? "An earlier topic"}</p>
        )}
        {replies.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted px-3 py-2">
            {open ? (
              <>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  className="self-start"
                  aria-expanded
                  onClick={() => toggle(id)}
                >
                  {earlier + folded.length} {earlier + folded.length === 1 ? "reply" : "replies"}
                  <ChevronDownIcon className="rotate-180" />
                </Button>
                <div className="flex min-w-0 flex-col gap-3 pt-1">
                  {replies.map((reply, at) => postBlock(reply, replies.slice(at + 1), id))}
                </div>
              </>
            ) : (
              <>
                {earlier > 0 ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    className="self-start"
                    aria-expanded={false}
                    onClick={() => toggle(id)}
                  >
                    {earlier} earlier {earlier === 1 ? "reply" : "replies"}
                    {replies.slice(0, earlier).some((reply) => reply.message.mentionsSelf) ? (
                      <Badge size="sm">@you</Badge>
                    ) : null}
                    <ChevronDownIcon />
                  </Button>
                ) : null}
                {folded.map((reply) => (
                  <button
                    key={reply.message.id}
                    type="button"
                    className={cn(
                      "min-w-0 truncate text-left text-sm text-foreground/90 hover:text-foreground",
                      reply.message.mentionsSelf && "text-primary",
                    )}
                    onClick={() => toggle(id)}
                  >
                    {replyLine(reply.message)}
                  </button>
                ))}
              </>
            )}
          </div>
        ) : null}
      </li>
    );
  };

  if (merged === null) {
    return (
      <p
        className={cn(
          "flex-1 p-4 text-sm",
          newest.error ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {newest.error ? newest.error.message : "Loading…"}
      </p>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const container = event.currentTarget;
          atBottom.current = isAtBottom(container);
          const place = placeOf(container);
          if (place !== undefined) places.set(key, place);
          const viewBottom = container.scrollTop + container.clientHeight;
          setAway({
            far: container.scrollHeight - viewBottom > JUMP_AFTER_PX,
            newBelow: newLine.current !== null && newLine.current.offsetTop > viewBottom,
          });
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
        {conversation.kind === "topic_group" ? (
          <ol className="flex flex-col gap-3 px-3 py-3">{topicsOf(rows).map(topic)}</ol>
        ) : (
          <ol className="flex flex-col px-3 py-3">
            {rows.map((row, index) => {
              const open = isOpen(row.message.id, row.thread);
              const replies = Math.max(row.message.replyCount ?? 0, row.thread.length);
              const previous = rows[index - 1];
              const timeBreak =
                previous !== undefined &&
                Date.parse(row.message.createdAt) - Date.parse(previous.message.createdAt) >=
                  TIME_BREAK_MS;
              return (
                <Fragment key={row.message.id}>
                  {timeBreak ? (
                    <li role="separator" className="mt-4 self-center text-xs text-muted-foreground">
                      {formatTimestamp(row.message.createdAt)}
                    </li>
                  ) : null}
                  {index === firstNew ? (
                    <li
                      ref={newLine}
                      role="separator"
                      className="mt-4 flex items-center gap-3 text-xs text-primary"
                    >
                      <span className="h-px flex-1 bg-primary/40" />
                      New messages
                      <span className="h-px flex-1 bg-primary/40" />
                    </li>
                  ) : null}
                  {item(
                    row,
                    timeBreak || index === firstNew ? undefined : previous,
                    rows.slice(index + 1),
                  )}
                  {row.thread.length > 0 ? (
                    <li className="-ms-[3px] mt-1 flex min-w-0 flex-col gap-3">
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        className="self-start"
                        aria-expanded={open}
                        onClick={() => toggle(row.message.id)}
                      >
                        {replies} {replies === 1 ? "reply" : "replies"}
                        {!open && row.thread.some((reply) => reply.message.mentionsSelf) ? (
                          <Badge size="sm">@you</Badge>
                        ) : null}
                        <ChevronDownIcon className={cn(open && "rotate-180")} />
                      </Button>
                      {open ? (
                        <ol className="ms-2 flex flex-col border-s border-border/70 ps-2">
                          {row.thread.map((reply, at) =>
                            item(
                              reply,
                              row.thread[at - 1],
                              row.thread.slice(at + 1),
                              row.message.id,
                            ),
                          )}
                        </ol>
                      ) : null}
                    </li>
                  ) : null}
                </Fragment>
              );
            })}
          </ol>
        )}
      </div>
      {away.far ? (
        <div className="absolute end-4 bottom-3">
          <Button
            size="sm"
            variant="glass"
            onClick={() => {
              const container = scrollRef.current;
              if (container === null) return;
              container.scrollTop = container.scrollHeight;
            }}
          >
            <ArrowDownIcon />
            {away.newBelow && newCount > 0
              ? `${newCount} new ${newCount === 1 ? "message" : "messages"}`
              : "Latest"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function DelegationChip({
  environmentId,
  delegation,
  onSelect,
}: {
  readonly environmentId: EnvironmentId;
  readonly delegation: InboxDelegation;
  readonly onSelect: (delegation: InboxDelegation) => void;
}) {
  const live =
    delegation.thread !== null && delegation.thread.detachedAt === null ? delegation.thread : null;
  return (
    <Button size="xs" variant="ghost-muted" onClick={() => onSelect(delegation)}>
      {live ? (
        <ThreadStatus
          environmentId={environmentId}
          thread={live}
          fallback={<DelegationOutcome delegation={delegation} idle="Delegated" />}
        />
      ) : (
        <DelegationOutcome delegation={delegation} idle="Delegated" />
      )}
    </Button>
  );
}

function MessageToolbar({
  message,
  readOnly,
  replyModes,
  onReply,
  onDelegate,
}: {
  readonly message: InboxMessage;
  readonly readOnly: boolean;
  readonly replyModes: ReadonlyArray<ReplyMode> | null;
  readonly onReply: (mode: ReplyMode | null) => void;
  readonly onDelegate: () => void;
}) {
  const both = replyModes !== null && replyModes.length > 1;
  return (
    <div className="hidden gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm group-focus-within/message:flex group-hover/message:flex">
      <IconAction
        label="Reply"
        disabled={readOnly}
        onClick={() => onReply(both ? "quote" : (replyModes?.[0] ?? null))}
      >
        {/* An open arrow reads smaller than the framed glyphs beside it. */}
        <ReplyIcon className="size-4" />
      </IconAction>
      {both ? (
        <IconAction label="Reply in thread" disabled={readOnly} onClick={() => onReply("thread")}>
          <MessageSquareReplyIcon />
        </IconAction>
      ) : null}
      <IconAction label="Delegate" disabled={readOnly} onClick={onDelegate}>
        <BotIcon />
      </IconAction>
      {message.openUrl ? (
        <IconAction
          label="Open in app"
          render={<a href={message.openUrl} target="_blank" rel="noreferrer noopener" />}
        >
          <ExternalLinkIcon />
        </IconAction>
      ) : null}
    </div>
  );
}

function Composer({
  environmentId,
  conversation,
  request,
  disabled,
  capabilities,
  onEngage,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly request: ReplyRequest | null;
  readonly disabled: boolean;
  readonly capabilities: ReadonlyArray<string>;
  readonly onEngage: () => void;
}) {
  const canMention = capabilities.includes("mentions");
  const canMarkdown = capabilities.includes("markdown");
  const canAttach = capabilities.includes("attachments");
  const storageKey = replyDraftKey(environmentId, conversation.channelId, conversation.id);
  const [saved] = useState(() => loadReply(storageKey));
  const [applied, setApplied] = useState<number | null>(null);
  const [text, setText] = useState(saved?.text ?? "");
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(saved?.replyTo ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the user types is sent as typed unless they ask for Markdown.
  const [markdown, setMarkdown] = useState(false);
  const [files, setFiles] = useState<ReadonlyArray<AttachedFile>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Null until the reply first holds an `@`.
  const [people, setPeople] = useState<ReadonlyArray<Mention> | null>(null);
  const [caret, setCaret] = useState(0);
  /** The highlighted suggestion, and the `@` whose suggestions Escape closed. */
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Answers `next` instead, taking back the mention the current quote reply put in front. */
  const retarget = (next: ReplyTarget | null) => {
    const named = canMention && replyTo?.inThread === false ? replyTo.mention : null;
    const base = named === null ? text : withoutMention(text, named.name);
    const nextText = namedInReply(canMention, next, base);
    setReplyTo(next);
    setText(nextText);
    setCaret(nextText.length);
  };
  if (request !== null && request.conversationId === conversation.id && request.nonce !== applied) {
    setApplied(request.nonce);
    retarget(request.replyTo);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus into the reply box when the user picks a message to answer
  useEffect(() => {
    const textarea = textareaRef.current;
    if (applied === null || textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [applied]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the reply into browser storage
  useEffect(() => {
    saveReply(storageKey, { text, replyTo });
  }, [storageKey, text, replyTo]);

  const readPeople = async () => {
    if (!canMention) return [];
    const next = await readMentionable(environmentId, conversation);
    // A failed read keeps who was known: the message still goes out, with fewer mentions.
    if (next === null) return people ?? [];
    setPeople(next);
    return next;
  };
  const wantPeople = (value: string) => {
    if (canMention && people === null && value.includes("@")) void readPeople();
  };

  const attach = (picked: ReadonlyArray<File>) => {
    const added = picked.slice(0, MAX_ATTACHMENTS - files.length).map((file) => ({
      key: nextReplyNonce(),
      name: file.name,
      file,
    }));
    if (added.length < picked.length) setError(`Attach up to ${MAX_ATTACHMENTS} files.`);
    setFiles((current) => [
      ...current,
      ...added.map(({ key, name }) => ({ key, name, uploadId: null })),
    ]);
    for (const { key, name, file } of added) {
      const path = `/inbox/upload?${new URLSearchParams({ channelId: conversation.channelId, name }).toString()}`;
      void forkRequest<Upload>(environmentId, path, { method: "POST", file }).then(
        (uploaded) =>
          setFiles((current) =>
            current.map((entry) =>
              entry.key === key ? { ...entry, uploadId: uploaded.uploadId } : entry,
            ),
          ),
        (cause: unknown) => {
          setFiles((current) => current.filter((entry) => entry.key !== key));
          setError(
            `Could not attach ${name}: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        },
      );
    }
  };
  const uploading = files.some((entry) => entry.uploadId === null);
  // Whom a quote reply names may be older than the messages read for people.
  const withReplied = (known: ReadonlyArray<Mention>) =>
    replyTo?.mention ? [...known, replyTo.mention] : known;
  const mentions = mentionsIn(text, withReplied(people ?? []));
  const found = mentionSuggestions(text, caret, people ?? []);
  const suggestions = found !== null && found.start !== dismissedAt ? found : null;
  const active =
    suggestions === null ? 0 : Math.min(activeSuggestion, suggestions.people.length - 1);
  const complete = (person: Mention) => {
    if (suggestions === null) return;
    const head = `${text.slice(0, suggestions.start)}@${person.name} `;
    // The caret can only be placed once the textarea holds the new text.
    flushSync(() => {
      setText(head + text.slice(caret));
      setCaret(head.length);
    });
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(head.length, head.length);
  };

  const send = async () => {
    setSending(true);
    setError(null);
    // Read again at send, so someone who wrote a moment ago can be mentioned.
    const failure = await sendReply(environmentId, {
      conversation,
      text,
      replyTo,
      delegationId: null,
      markdown: canMarkdown && markdown,
      people: text.includes("@") ? withReplied(await readPeople()) : [],
      attachments: files,
    });
    setSending(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    setText("");
    setReplyTo(null);
    setMarkdown(false);
    setFiles([]);
  };

  const sendKey = useSendKey();
  const canSend =
    !disabled && !sending && !uploading && (text.trim().length > 0 || files.length > 0);
  const status = error ? (
    <span className="text-destructive-foreground">{error}</span>
  ) : mentions.length > 0 ? (
    <span className="text-muted-foreground">
      Notifies {mentions.map((mention) => mention.name).join(", ")}
    </span>
  ) : null;
  return (
    <form
      className="relative shrink-0 px-3 pb-3"
      onFocus={() => {
        onEngage();
        wantPeople(text);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) void send();
      }}
    >
      <ReplyBox
        ref={textareaRef}
        aria-label="Reply"
        value={text}
        mentions={mentions.map((mention) => mention.name)}
        disabled={disabled}
        placeholder={disabled ? "Sending is off" : `Message ${nameOrUnknown(conversation.name)}`}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setActiveSuggestion(0);
          wantPeople(event.target.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onPaste={(event) => {
          // A pasted screenshot arrives as a file; pasted text is left to the textarea.
          if (!canAttach || event.clipboardData.files.length === 0) return;
          event.preventDefault();
          attach([...event.clipboardData.files]);
        }}
        onKeyDown={(event) => {
          if (suggestions !== null && !event.metaKey && !event.ctrlKey) {
            const count = suggestions.people.length;
            const pick = suggestions.people[active];
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActiveSuggestion((active + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
              return;
            }
            if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && pick) {
              event.preventDefault();
              complete(pick);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDismissedAt(suggestions.start);
              return;
            }
          }
          if (sendKey.isSend(event)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        above={
          replyTo !== null || files.length > 0 ? (
            <>
              {replyTo !== null ? (
                <div className="flex min-w-0 items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {replyTo.inThread === true ? "Replying in thread to" : "Replying to"}{" "}
                    {replyTo.quote}
                  </p>
                  {replyTo.canSwitch ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      onClick={() => retarget({ ...replyTo, inThread: replyTo.inThread !== true })}
                    >
                      {replyTo.inThread === true ? "Quote instead" : "Reply in thread"}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Send as a new message"
                    onClick={() => retarget(null)}
                  >
                    <XIcon />
                  </Button>
                </div>
              ) : null}
              {files.length > 0 ? (
                <ul className="flex flex-wrap gap-1" aria-label="Attached files">
                  {files.map((entry) => (
                    <li
                      key={entry.key}
                      className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 py-0.5 ps-2 pe-0.5 text-xs"
                    >
                      <span className="max-w-48 truncate">{entry.name}</span>
                      {entry.uploadId === null ? (
                        <span className="text-muted-foreground">Uploading…</span>
                      ) : null}
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label={`Remove ${entry.name}`}
                        onClick={() => setFiles(files.filter((other) => other.key !== entry.key))}
                      >
                        <XIcon />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null
        }
        status={status}
        actions={
          <>
            {canMarkdown ? (
              <IconAction
                type="button"
                label="Send as Markdown"
                variant={markdown ? "outline" : "ghost-muted"}
                aria-pressed={markdown}
                disabled={disabled}
                onClick={() => setMarkdown(!markdown)}
              >
                <MarkdownIcon />
              </IconAction>
            ) : null}
            {canAttach ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    attach([...(event.target.files ?? [])]);
                    // The same file can be picked again after it was removed.
                    event.target.value = "";
                  }}
                />
                <IconAction
                  type="button"
                  label="Attach files"
                  disabled={disabled || files.length >= MAX_ATTACHMENTS}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon />
                </IconAction>
              </>
            ) : null}
          </>
        }
        sending={sending}
        canSend={canSend}
      />
      {suggestions !== null ? (
        // Above the reply box over the messages, as the chat app opens its picker.
        <div
          role="listbox"
          aria-label="People to mention"
          className="absolute inset-x-3 bottom-full z-20 mb-1 flex flex-col rounded-lg border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <p className="px-2 py-1 text-xs text-muted-foreground">People in this chat</p>
          {suggestions.people.map((person, index) => (
            <button
              key={person.userId}
              type="button"
              role="option"
              aria-selected={index === active}
              className={cn(
                "rounded-md px-2 py-1.5 text-left text-sm",
                index === active ? "bg-accent" : "hover:bg-accent/50",
              )}
              // Keeps the caret in the textarea, where `complete` reads it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveSuggestion(index)}
              onClick={() => complete(person)}
            >
              {person.name}
            </button>
          ))}
        </div>
      ) : null}
    </form>
  );
}

/** The Markdown mark, drawn like the lucide icons around it; lucide has none. */
function MarkdownIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M6 15V9l3 3 3-3v6" />
      <path d="M17 9v6m-2-2 2 2 2-2" />
    </svg>
  );
}
