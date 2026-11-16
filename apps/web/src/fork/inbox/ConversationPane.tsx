import type { EnvironmentId } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  BotIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  PaperclipIcon,
  ReplyIcon,
  SendIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

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
  Mention,
  SendResult,
  Upload,
} from "../types";
import { useForkResource, type ForkRefreshFilter } from "../useForkResource";
import { ThreadStatus } from "./DelegationPane";
import { ConversationMenu } from "./InboxList";
import {
  conversationRows,
  mentionablePeople,
  mentionsIn,
  mentionSuggestions,
  mergeConversationPages,
  nameOrUnknown,
  quoteOfMessage,
  skippedNotice,
  type ConversationRow,
  type OlderPages,
} from "./inboxView";
import { MessageView } from "./MessageView";
import { loadReply, replyDraftKey, saveReply } from "./replyDrafts";

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
  /** The conversation it is for; another conversation's reply box ignores it. */
  readonly conversationId: string;
  readonly replyTo: ReplyTarget | null;
  /** A delegation's draft, sent on its behalf. */
  readonly draft: { readonly text: string; readonly delegationId: string } | null;
}

export interface ReplyTarget {
  readonly messageId: string;
  readonly quote: string;
}

/** A file picked for the reply; `uploadId` is null while it is on its way to the adapter. */
interface AttachedFile {
  readonly key: number;
  readonly name: string;
  readonly uploadId: string | null;
}

const MAX_ATTACHMENTS = 9;

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
  capabilities,
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
  /** The optional parts of the protocol the channel's adapter implements. */
  readonly capabilities: ReadonlyArray<string>;
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
      conversationId: conversation.id,
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
        capabilities={capabilities}
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
  /** Threads the reader opened, or closed after one opened by itself. */
  const [toggledThreads, setToggledThreads] = useState<ReadonlySet<string>>(new Set());

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
    const target =
      focusShown && focusMessageId !== null
        ? container.querySelector(`[data-message-id="${CSS.escape(focusMessageId)}"]`)
        : null;
    if (target) target.scrollIntoView({ block: "nearest" });
    else container.scrollTop = container.scrollHeight;
    atBottom.current = isAtBottom(container);
  }, [focusMessageId, loaded, focusShown]);

  const item = (
    row: ConversationRow,
    previous: ConversationRow | undefined,
    later: ReadonlyArray<ConversationRow>,
  ) => (
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
        showAuthor={previous?.message.author.id !== row.message.author.id}
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
            later.map((next) => next.message),
          )
        }
      />
    </li>
  );

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
        {rows.map((row, index) => {
          const holdsFocus = row.thread.some((reply) => reply.message.id === focusMessageId);
          // A thread opens by itself for the message a delegation points at.
          const open = toggledThreads.has(row.message.id) ? !holdsFocus : holdsFocus;
          const replies = row.thread.length;
          return (
            <Fragment key={row.message.id}>
              {item(row, rows[index - 1], rows.slice(index + 1))}
              {replies > 0 ? (
                <li className="flex min-w-0 flex-col gap-2 ps-3">
                  <span>
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      aria-expanded={open}
                      onClick={() =>
                        setToggledThreads((current) => {
                          const next = new Set(current);
                          if (!next.delete(row.message.id)) next.add(row.message.id);
                          return next;
                        })
                      }
                    >
                      <ChevronRightIcon className={cn(open && "rotate-90")} />
                      {replies} {replies === 1 ? "reply" : "replies"} in thread
                      {row.thread.some((reply) => reply.message.mentionsSelf)
                        ? " · mentions you"
                        : ""}
                    </Button>
                  </span>
                  {open ? (
                    <ol className="flex flex-col gap-3 border-s border-border/70 ps-2">
                      {row.thread.map((reply, at) =>
                        item(reply, row.thread[at - 1] ?? row, row.thread.slice(at + 1)),
                      )}
                    </ol>
                  ) : null}
                </li>
              ) : null}
            </Fragment>
          );
        })}
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
  const [draft, setDraft] = useState<{
    readonly delegationId: string;
    readonly text: string;
  } | null>(saved?.draft ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An agent writes its draft in Markdown; what the user types is sent as typed unless they ask.
  const [markdown, setMarkdown] = useState(saved?.draft != null);
  const [files, setFiles] = useState<ReadonlyArray<AttachedFile>>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Null until the reply first holds an `@`.
  const [people, setPeople] = useState<ReadonlyArray<Mention> | null>(null);
  const [caret, setCaret] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  if (request !== null && request.conversationId === conversation.id && request.nonce !== applied) {
    setApplied(request.nonce);
    setReplyTo(request.replyTo);
    if (request.draft !== null) {
      setDraft(request.draft);
      setText(request.draft.text);
      setMarkdown(true);
    }
  }
  const fromDraft = draft !== null && text === draft.text;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the reply into browser storage
  useEffect(() => {
    saveReply(storageKey, { text, replyTo, draft });
  }, [storageKey, text, replyTo, draft]);

  const readPeople = async () => {
    if (!canMention) return [];
    const page = await forkRequest<ConversationResponse>(
      environmentId,
      `/inbox/conversation?${new URLSearchParams({
        channelId: conversation.channelId,
        conversationId: conversation.id,
      }).toString()}`,
    ).catch(() => null);
    // A failed read keeps who was known: the message still goes out, with fewer mentions.
    if (page === null) return people ?? [];
    const next = mentionablePeople(page.messages);
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
  const mentions = mentionsIn(text, people ?? []);
  const suggestions = mentionSuggestions(text, caret, people ?? []);
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
    const mentioned = text.includes("@") ? mentionsIn(text, await readPeople()) : [];
    const result = await forkRequest<SendResult>(environmentId, "/inbox/send", {
      method: "POST",
      body: {
        channelId: conversation.channelId,
        conversationId: conversation.id,
        ...(replyTo ? { replyToId: replyTo.messageId } : {}),
        // An edited draft still answers for its delegation; the copy records the edit.
        ...(draft ? { delegationId: draft.delegationId } : {}),
        text,
        ...(mentioned.length > 0 ? { mentions: mentioned } : {}),
        ...(canMarkdown && markdown ? { format: "markdown" } : {}),
        ...(files.length > 0
          ? { attachments: files.map(({ uploadId, name }) => ({ uploadId, name })) }
          : {}),
      },
    }).catch((cause: unknown) => ({
      failure:
        cause instanceof ForkApiError && cause.code === "delivery_unknown"
          ? "Delivery unknown: the adapter did not confirm the message. Check the chat before sending again."
          : cause instanceof Error
            ? cause.message
            : String(cause),
    }));
    setSending(false);
    if ("failure" in result) {
      setError(result.failure);
      return;
    }
    setText("");
    setReplyTo(null);
    setDraft(null);
    setMarkdown(false);
    setFiles([]);
    if (result.failedAttachments.length > 0) {
      toastManager.add({
        type: "warning",
        title: `Sent, but these files did not go out: ${result.failedAttachments.join(", ")}.`,
      });
    }
    if (result.unresolvedMentions.length > 0) {
      toastManager.add({
        type: "warning",
        title: `Sent, but not everyone was notified: ${result.unresolvedMentions.join(", ")}.`,
      });
    }
    if (result.archived === false) {
      toastManager.add({
        type: "warning",
        title: "Sent, but the copy in the delegation's folder could not be saved.",
      });
    }
  };

  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-t border-border/70 p-3"
      onFocus={() => {
        onEngage();
        wantPeople(text);
      }}
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
        ref={textareaRef}
        aria-label="Reply"
        value={text}
        rows={2}
        disabled={disabled}
        placeholder={disabled ? "Sending is off" : `Message ${nameOrUnknown(conversation.name)}`}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
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
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          } else if (event.key === "Tab" && !event.shiftKey && suggestions !== null) {
            event.preventDefault();
            complete(suggestions.people[0]!);
          }
        }}
      />
      {suggestions !== null ? (
        <div className="flex flex-wrap gap-1" aria-label="People to mention">
          {suggestions.people.map((person) => (
            <Button
              key={person.userId}
              type="button"
              size="xs"
              variant="outline"
              onClick={() => complete(person)}
            >
              @{person.name}
            </Button>
          ))}
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
      <div className="flex items-center gap-2">
        {error ? (
          <p className="min-w-0 flex-1 text-xs text-destructive-foreground">{error}</p>
        ) : mentions.length > 0 ? (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Notifies {mentions.map((mention) => mention.name).join(", ")}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        {canMarkdown ? (
          <Button
            type="button"
            size="xs"
            variant={markdown ? "outline" : "ghost-muted"}
            aria-pressed={markdown}
            disabled={disabled}
            onClick={() => setMarkdown(!markdown)}
          >
            Markdown
          </Button>
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
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Attach files"
              disabled={disabled || files.length >= MAX_ATTACHMENTS}
              onClick={() => fileInputRef.current?.click()}
            >
              <PaperclipIcon />
            </Button>
          </>
        ) : null}
        <Button
          type="submit"
          size="sm"
          disabled={
            disabled || sending || uploading || (text.trim().length === 0 && files.length === 0)
          }
        >
          <SendIcon />
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
