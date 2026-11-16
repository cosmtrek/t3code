import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon, BotIcon, ExternalLinkIcon, ReplyIcon, SendIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { ForkApiError, forkRequest } from "../forkApiAccess";
import type {
  ConversationResponse,
  InboxConversation,
  InboxDelegation,
  InboxMessage,
  SendResult,
} from "../types";
import { useForkResource, type ForkRefreshFilter } from "../useForkResource";
import { ThreadStatus } from "./DelegationPane";
import { ConversationMenu } from "./InboxList";
import {
  conversationRows,
  mergeConversationPages,
  nameOrUnknown,
  quoteOfMessage,
  skippedNotice,
  type OlderPages,
} from "./inboxView";
import { MessageView } from "./MessageView";

export interface ConversationPaneHandlers {
  readonly onBack: () => void;
  readonly onSetRead: (conversation: InboxConversation, read: boolean) => void;
  readonly onSelectDelegation: (delegation: InboxDelegation) => void;
  /** Delegate starting at `message`; `later` is what the chat shows after it. */
  readonly onDelegate: (message: InboxMessage, later: ReadonlyArray<InboxMessage>) => void;
  /** The user acts in the conversation, such as starting a reply: what arrived since is read. */
  readonly onEngage: () => void;
}

/** What the reply box should hold; a new `nonce` replaces what it holds. */
export interface ReplyRequest {
  readonly nonce: number;
  readonly replyTo: ReplyTarget | null;
  /** A delegation's draft, sent on its behalf. */
  readonly draft: { readonly text: string; readonly delegationId: string } | null;
}

export interface ReplyTarget {
  readonly messageId: string;
  readonly quote: string;
}

let replyNonce = 0;
/** Orders requests from the page and from the chat's own toolbar; the newest wins. */
export const nextReplyNonce = () => ++replyNonce;

/** Older messages load once the reader scrolls this close to the top. */
const LOAD_OLDER_PX = 200;
const AT_BOTTOM_PX = 24;
/** How many older pages to read looking for a delegation's first message before giving up. */
const FIND_FOCUS_PAGES = 5;

const isAtBottom = (container: HTMLElement) =>
  container.scrollHeight - container.scrollTop - container.clientHeight < AT_BOTTOM_PX;

/** The conversation as a chat, with the reply box under it. */
export function ConversationPane({
  environmentId,
  conversation,
  delegations,
  focusMessageId,
  readOnly,
  replyRequest,
  handlers,
  refreshOn,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly delegations: ReadonlyArray<InboxDelegation>;
  /** The selected delegation's first message, scrolled to and marked. */
  readonly focusMessageId: string | null;
  readonly readOnly: boolean;
  readonly replyRequest: ReplyRequest | null;
  readonly handlers: ConversationPaneHandlers;
  readonly refreshOn: ForkRefreshFilter;
  readonly className?: string;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  const shown = useShown(sectionRef);
  const [localRequest, setLocalRequest] = useState<ReplyRequest | null>(null);
  const request =
    localRequest !== null && (replyRequest === null || localRequest.nonce > replyRequest.nonce)
      ? localRequest
      : replyRequest;
  const replyTo = (message: InboxMessage) =>
    setLocalRequest({
      nonce: nextReplyNonce(),
      replyTo: { messageId: message.id, quote: quoteOfMessage(message) },
      draft: null,
    });
  return (
    <section
      ref={sectionRef}
      aria-label="Conversation"
      className={cn("min-h-0 min-w-0 flex-1 flex-col", className)}
    >
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Back to the list"
          className="@2xl/inbox:hidden"
          onClick={handlers.onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <h2 className="min-w-0 flex-1 truncate px-1 text-xs font-medium">
          {nameOrUnknown(conversation.name)}
        </h2>
        <ConversationMenu conversation={conversation} onSetRead={handlers.onSetRead} />
      </div>
      {shown ? (
        <ConversationMessages
          key={`${conversation.channelId}\u0000${conversation.id}`}
          environmentId={environmentId}
          conversation={conversation}
          delegations={delegations}
          focusMessageId={focusMessageId}
          readOnly={readOnly}
          handlers={handlers}
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
        onEngage={handlers.onEngage}
      />
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
  conversation,
  delegations,
  focusMessageId,
  readOnly,
  handlers,
  onReply,
  refreshOn,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly delegations: ReadonlyArray<InboxDelegation>;
  readonly focusMessageId: string | null;
  readonly readOnly: boolean;
  readonly handlers: ConversationPaneHandlers;
  readonly onReply: (message: InboxMessage) => void;
  readonly refreshOn: ForkRefreshFilter;
}) {
  const path = `/inbox/conversation?${new URLSearchParams({
    channelId: conversation.channelId,
    conversationId: conversation.id,
  }).toString()}`;
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
  const rows = merged ? conversationRows(merged.messages, delegations) : [];
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

  // The focused message may be older than the pages read; read back a few pages to find it.
  const focusShown = rows.some((row) => row.message.id === focusMessageId);
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
    const target =
      focusShown && focusMessageId !== null
        ? container.querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`)
        : null;
    if (target) target.scrollIntoView({ block: "nearest" });
    else container.scrollTop = container.scrollHeight;
    atBottom.current = isAtBottom(container);
  }, [focusMessageId, loaded, focusShown]);

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
        {rows.map((row, index) => (
          <li
            key={row.message.id}
            data-message-id={row.message.id}
            className={cn(
              "group relative flex min-w-0 scroll-mt-4 flex-col rounded-lg px-1 py-1",
              row.message.id === focusMessageId && "bg-accent/40 ring-1 ring-primary/40",
            )}
          >
            <MessageView
              environmentId={environmentId}
              channelId={conversation.channelId}
              message={row.message}
              showAuthor={rows[index - 1]?.message.author.id !== row.message.author.id}
              quote={row.quote}
            >
              {row.delegations.length > 0 ? (
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  {row.delegations.map((delegation) => (
                    <DelegationChip
                      key={delegation.id}
                      environmentId={environmentId}
                      delegation={delegation}
                      onSelect={handlers.onSelectDelegation}
                    />
                  ))}
                </span>
              ) : null}
            </MessageView>
            <MessageToolbar
              message={row.message}
              readOnly={readOnly}
              onReply={() => onReply(row.message)}
              onDelegate={() =>
                handlers.onDelegate(
                  row.message,
                  rows.slice(index + 1).map((later) => later.message),
                )
              }
            />
          </li>
        ))}
      </ol>
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
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-1.5 py-0.5 hover:bg-accent"
      onClick={() => onSelect(delegation)}
    >
      <BotIcon className={cn("size-3", delegation.agentUnseen && "text-primary")} />
      {live ? (
        <ThreadStatus environmentId={environmentId} thread={live} />
      ) : (
        <span className="text-muted-foreground">Delegated</span>
      )}
      {delegation.hasDraft ? <span className="text-success">Draft</span> : null}
    </button>
  );
}

function MessageToolbar({
  message,
  readOnly,
  onReply,
  onDelegate,
}: {
  readonly message: InboxMessage;
  readonly readOnly: boolean;
  readonly onReply: () => void;
  readonly onDelegate: () => void;
}) {
  return (
    <div className="absolute -top-3 right-2 z-10 hidden gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Reply"
        disabled={readOnly}
        onClick={onReply}
      >
        <ReplyIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Delegate"
        disabled={readOnly}
        onClick={onDelegate}
      >
        <BotIcon />
      </Button>
      {message.openUrl ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open in app"
          render={<a href={message.openUrl} target="_blank" rel="noreferrer noopener" />}
        >
          <ExternalLinkIcon />
        </Button>
      ) : null}
    </div>
  );
}

function Composer({
  environmentId,
  conversation,
  request,
  disabled,
  onEngage,
}: {
  readonly environmentId: EnvironmentId;
  readonly conversation: InboxConversation;
  readonly request: ReplyRequest | null;
  readonly disabled: boolean;
  readonly onEngage: () => void;
}) {
  const [applied, setApplied] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [draft, setDraft] = useState<{
    readonly delegationId: string;
    readonly text: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (request !== null && request.nonce !== applied) {
    setApplied(request.nonce);
    setReplyTo(request.replyTo);
    if (request.draft !== null) {
      setDraft(request.draft);
      setText(request.draft.text);
    }
  }
  const fromDraft = draft !== null && text === draft.text;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await forkRequest<SendResult>(environmentId, "/inbox/send", {
        method: "POST",
        body: {
          channelId: conversation.channelId,
          conversationId: conversation.id,
          ...(replyTo ? { replyToId: replyTo.messageId } : {}),
          // An edited draft still answers for its delegation; the copy records the edit.
          ...(draft ? { delegationId: draft.delegationId } : {}),
          text,
        },
      });
      setText("");
      setReplyTo(null);
      setDraft(null);
      setSending(false);
      if (result.archived === false) {
        toastManager.add({
          type: "warning",
          title: "Sent, but the copy in the delegation's folder could not be saved.",
        });
      }
    } catch (cause) {
      setSending(false);
      setError(
        cause instanceof ForkApiError && cause.code === "delivery_unknown"
          ? "Delivery unknown: the adapter did not confirm the message. Check the chat before sending again."
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    }
  };

  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-t border-border/70 p-3"
      onFocus={onEngage}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {replyTo !== null || fromDraft ? (
        <div className="flex min-w-0 items-center gap-2">
          {replyTo !== null ? (
            <>
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                In the reply thread of {replyTo.quote}
              </p>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Send as a new message"
                onClick={() => setReplyTo(null)}
              >
                <XIcon />
              </Button>
            </>
          ) : (
            <span className="flex-1" />
          )}
          {fromDraft ? <Badge variant="info">Draft</Badge> : null}
        </div>
      ) : null}
      <Textarea
        aria-label="Reply"
        value={text}
        rows={2}
        disabled={disabled}
        placeholder={disabled ? "Sending is off" : `Message ${nameOrUnknown(conversation.name)}`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <div className="flex items-center gap-2">
        {error ? (
          <p className="min-w-0 flex-1 text-xs text-destructive-foreground">{error}</p>
        ) : (
          <span className="flex-1" />
        )}
        <Button type="submit" size="sm" disabled={disabled || sending || text.trim().length === 0}>
          <SendIcon />
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
