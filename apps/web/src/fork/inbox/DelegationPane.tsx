import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { CHAT_USER_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { forkRequest } from "../forkApiAccess";
import { useFormatTimestamp } from "../presentation";
import type { DelegationDetail, FollowUp, LinkedThread } from "../types";
import { authorsSummary, skippedNotice } from "./inboxView";
import { MessageView } from "./MessageView";

/** The sidebar's words, for when the thread is not in this client's sidebar state. */
const THREAD_STATUS_LABELS: Readonly<Record<LinkedThread["status"], string | null>> = {
  running: "Working",
  idle: null,
  archived: "Archived",
  deleted: "Thread deleted",
  unknown: null,
};

/**
 * A delegation: what the thread found, the conversation with it, and the reply. The thread does
 * the work; this pane only asks it things and takes the reply when the user wants one.
 */
export function DelegationPane({
  environmentId,
  detail,
  sendingOff,
  onUseDraft,
  onDiscardDraft,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
  readonly sendingOff: boolean;
  /** Puts the draft into the conversation's reply box. */
  readonly onUseDraft: (text: string) => void;
  readonly onDiscardDraft: (draft: string) => void;
}) {
  const thread = detail.delegation.thread;
  const live = thread !== null && thread.status !== "deleted" ? thread : null;
  const shell = useThreadShell(
    live ? scopeThreadRef(environmentId, ThreadId.make(live.threadId)) : null,
  );
  const cwd = shell?.worktreePath ?? undefined;
  const canAsk = live !== null && live.status !== "archived" && !detail.conclusionIsHistorical;
  const draft = detail.draft?.trim() ?? "";
  const formatTimestamp = useFormatTimestamp();
  const draftCard = (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/70 bg-muted/40 p-3">
      <p className="text-sm whitespace-pre-wrap wrap-anywhere">{draft}</p>
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={sendingOff || !detail.canSend}
          onClick={() => onUseDraft(draft)}
        >
          Accept
        </Button>
        <Button size="xs" variant="ghost-muted" onClick={() => onDiscardDraft(draft)}>
          Discard
        </Button>
      </div>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-3">
        <SourceMessages environmentId={environmentId} detail={detail} />

        <Section
          title={detail.conclusionIsHistorical ? "Earlier conclusion" : "Conclusion"}
          accessory={live ? <ThreadStatus environmentId={environmentId} thread={live} /> : null}
        >
          {detail.conclusion !== null ? (
            <ChatMarkdown
              text={detail.conclusion}
              cwd={cwd}
              headingLevelOffset={3}
              className="text-sm"
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {thread === null
                ? "No thread yet."
                : live === null
                  ? "The thread was deleted."
                  : live.status === "idle"
                    ? "Finished without a conclusion."
                    : "None yet."}
            </p>
          )}
        </Section>

        {draft.length > 0 && detail.followUps.length === 0 ? (
          <Section title="Draft reply">{draftCard}</Section>
        ) : null}

        {detail.sent.length > 0 ? (
          <Section title="Replied">
            <ol className="flex flex-col gap-2">
              {detail.sent.map((reply) => (
                <li key={reply.sentAt} className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs text-muted-foreground">
                    <time dateTime={reply.sentAt}>{formatTimestamp(reply.sentAt)}</time> ·{" "}
                    {reply.source}
                  </span>
                  <p className="line-clamp-3 text-sm whitespace-pre-wrap wrap-anywhere text-foreground/80">
                    {reply.text}
                  </p>
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        {detail.followUps.length > 0 ? (
          <Section title="With the agent">
            <ol className="flex flex-col gap-3">
              {detail.followUps.map((entry) => (
                <li key={`${entry.role}:${entry.at}`} className="flex min-w-0 flex-col gap-0.5">
                  <FollowUpEntry entry={entry} cwd={cwd} />
                </li>
              ))}
              {draft.length > 0 ? <li className="flex min-w-0 flex-col">{draftCard}</li> : null}
            </ol>
          </Section>
        ) : null}
      </div>
      {canAsk ? (
        <AgentComposer
          key={live.threadId}
          environmentId={environmentId}
          detail={detail}
          draft={draft}
          onDraftReady={sendingOff || !detail.canSend ? null : onUseDraft}
        />
      ) : null}
    </div>
  );
}

function Section({
  title,
  accessory,
  children,
}: {
  readonly title: string;
  readonly accessory?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2 border-t border-border/60 pt-3.5">
      <header className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {title}
        </h3>
        {accessory}
      </header>
      {children}
    </section>
  );
}

/** The delegated messages, folded to their authors: once delegated, the findings matter more. */
function SourceMessages({
  environmentId,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
}) {
  const [open, setOpen] = useState(false);
  const authors = authorsSummary(detail.messages);
  const count = detail.messages.length;
  const notices = [
    detail.complete
      ? null
      : "These messages run past what T3 Code reads; only part of them is shown.",
    detail.rootMissing
      ? "The message this reply thread started from is no longer available."
      : null,
    skippedNotice(detail.skipped),
  ].filter((notice) => notice !== null);
  return (
    <section className="flex min-w-0 flex-col gap-2">
      {count === 0 ? null : (
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setOpen(!open)}
        >
          <ChevronDownIcon className={cn("size-3.5 shrink-0", !open && "-rotate-90")} />
          <span className="shrink-0 font-medium">
            {count === 1 ? "1 message" : `${count} messages`}
          </span>
          {authors !== null && !open ? <span className="min-w-0 truncate">· {authors}</span> : null}
        </button>
      )}
      {notices.map((notice) => (
        <p key={notice} className="text-xs text-warning">
          {notice}
        </p>
      ))}
      {open ? (
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
          <ol className="flex flex-col gap-3">
            {detail.messages.map((message, index) => (
              <li key={message.id} className="flex min-w-0 flex-col">
                <MessageView
                  environmentId={environmentId}
                  channelId={detail.delegation.channelId}
                  message={message}
                  showAuthor={detail.messages[index - 1]?.author.id !== message.author.id}
                />
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}

function FollowUpEntry({
  entry,
  cwd,
}: {
  readonly entry: FollowUp;
  readonly cwd: string | undefined;
}) {
  if (entry.role === "assistant") {
    return <ChatMarkdown text={entry.text} cwd={cwd} headingLevelOffset={3} className="text-sm" />;
  }
  return (
    <div className="flex max-w-[90%] flex-col gap-0.5 self-end rounded-2xl rounded-tr-sm bg-muted px-3 py-2">
      {entry.kind === "draft" ? (
        entry.text.length > 0 ? (
          <>
            <span className="text-2xs font-medium text-muted-foreground">Draft reply</span>
            <UserText text={entry.text} cwd={cwd} />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Draft a reply</p>
        )
      ) : (
        <UserText text={entry.text} cwd={cwd} />
      )}
    </div>
  );
}

/** What the user asked, rendered like their messages in chat so quotes show as cards. */
function UserText({ text, cwd }: { readonly text: string; readonly cwd: string | undefined }) {
  return (
    <ChatMarkdown
      text={text}
      cwd={cwd}
      className="text-sm wrap-anywhere"
      lineBreaks
      parseRawHtml={false}
      extraRemarkPlugins={CHAT_USER_MARKDOWN_REMARK_PLUGINS}
      headingLevelOffset={3}
    />
  );
}

/**
 * One box for the thread: a question, or how to write the reply. Nothing typed here reaches the
 * chat app; the reply lands in the draft and goes out only from the conversation's reply box.
 */
function AgentComposer({
  environmentId,
  detail,
  draft,
  onDraftReady,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
  readonly draft: string;
  /** Takes a draft the thread wrote in answer to this box. */
  readonly onDraftReady: ((text: string) => void) | null;
}) {
  const [text, setText] = useState("");
  // The newest request the thread had recorded when this one was sent; waiting until it moves.
  const [sentAfter, setSentAfter] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const lastAsked = detail.followUps.findLast((entry) => entry.role === "user")?.at ?? null;
  const waiting = sentAfter !== undefined && sentAfter === lastAsked;
  const working = waiting || detail.followUps.at(-1)?.role === "user";
  // The draft when the last message went out; a different one after the run answers it.
  const draftBefore = useRef<string | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hands the requested draft to the reply box, which lives outside this pane, once the run ends
  useEffect(() => {
    const before = draftBefore.current;
    if (before === undefined || working) return;
    draftBefore.current = undefined;
    if (draft.length > 0 && draft !== before) onDraftReady?.(draft);
  }, [working, draft, onDraftReady]);

  const submit = async () => {
    const value = text.trim();
    if (value.length === 0) return;
    setSentAfter(lastAsked);
    draftBefore.current = draft;
    setError(null);
    setText("");
    const failure = await forkRequest(environmentId, "/inbox/ask", {
      method: "POST",
      body: {
        channelId: detail.delegation.channelId,
        delegationId: detail.delegation.id,
        text: value,
      },
    }).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
    if (failure !== null) {
      setSentAfter(undefined);
      draftBefore.current = undefined;
      setText(value);
      setError(failure);
    }
  };

  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-t border-border/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Textarea
        aria-label="Message the agent"
        value={text}
        rows={2}
        placeholder="Ask the agent, or tell it what to reply…"
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
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            {working ? "Working…" : null}
          </p>
        )}
        <Button type="submit" size="sm" disabled={waiting || text.trim().length === 0}>
          Ask
        </Button>
      </div>
    </form>
  );
}

/**
 * The thread's status as the sidebar shows it, live from this client's thread state. A finished
 * thread shows `fallback` instead: the inbox marks unseen results itself, so "Completed" is noise.
 */
export function ThreadStatus({
  environmentId,
  thread,
  fallback = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: LinkedThread;
  readonly fallback?: ReactNode;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, ThreadId.make(thread.threadId)));
  const pill = shell ? resolveThreadStatusPill({ thread: shell }) : null;
  if (pill !== null && pill.label !== "Completed") {
    return (
      <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", pill.colorClass)}>
        <span className={cn("size-1.5 rounded-full", pill.dotClass)} />
        {pill.label}
      </span>
    );
  }
  const label = THREAD_STATUS_LABELS[thread.status];
  if (label === null) return fallback;
  return <span className="shrink-0 text-xs text-muted-foreground">{label}</span>;
}
