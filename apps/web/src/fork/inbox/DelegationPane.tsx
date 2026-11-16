import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, CornerDownLeftIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { forkRequest } from "../forkApiAccess";
import { formatTimestamp } from "../presentation";
import type { DelegationDetail, FollowUp, LinkedThread } from "../types";
import { quoteOfMessage, skippedNotice } from "./inboxView";
import { MessageView } from "./MessageView";

/** The sidebar's words, for when the thread is not in this client's sidebar state. */
const THREAD_STATUS_LABELS: Readonly<Record<LinkedThread["status"], string | null>> = {
  running: "Working",
  idle: "Done",
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
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
  readonly sendingOff: boolean;
  /** Puts the draft into the conversation's reply box. */
  readonly onUseDraft: (text: string) => void;
}) {
  const thread = detail.delegation.thread;
  const live = thread !== null && thread.status !== "deleted" ? thread : null;
  const shell = useThreadShell(
    live ? scopeThreadRef(environmentId, ThreadId.make(live.threadId)) : null,
  );
  const cwd = shell?.worktreePath ?? undefined;
  const canAsk = live !== null && live.status !== "archived" && !detail.conclusionIsHistorical;
  const draft = detail.draft?.trim() ?? "";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 py-3">
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

        {detail.followUps.length > 0 ? (
          <Section title="With the agent">
            <ol className="flex flex-col gap-3">
              {detail.followUps.map((entry) => (
                <li key={`${entry.role}:${entry.at}`} className="flex min-w-0 flex-col gap-0.5">
                  <FollowUpEntry entry={entry} cwd={cwd} />
                </li>
              ))}
            </ol>
          </Section>
        ) : null}

        {draft.length > 0 ? (
          <Section title="Draft reply">
            <p className="text-sm whitespace-pre-wrap wrap-anywhere">{draft}</p>
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              disabled={sendingOff || !detail.canSend}
              onClick={() => onUseDraft(draft)}
            >
              <CornerDownLeftIcon />
              Use in reply
            </Button>
          </Section>
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
      </div>
      {canAsk ? (
        <AgentComposer key={live.threadId} environmentId={environmentId} detail={detail} />
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
    <section className="flex min-w-0 flex-col gap-2">
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

/** The delegated messages, folded to their first line: once delegated, the findings matter more. */
function SourceMessages({
  environmentId,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
}) {
  const [open, setOpen] = useState(false);
  const first = detail.messages[0];
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
          <ChevronDownIcon className={cn("size-3 shrink-0", !open && "-rotate-90")} />
          <span className="shrink-0 font-medium">
            {count === 1 ? "1 message" : `${count} messages`}
          </span>
          {first && !open ? (
            <span className="min-w-0 truncate">{quoteOfMessage(first)}</span>
          ) : null}
        </button>
      )}
      {notices.map((notice) => (
        <p key={notice} className="text-xs text-warning">
          {notice}
        </p>
      ))}
      {open ? (
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
    return (
      <>
        <span className="text-xs font-medium text-muted-foreground">Agent</span>
        <ChatMarkdown text={entry.text} cwd={cwd} headingLevelOffset={3} className="text-sm" />
      </>
    );
  }
  return (
    <>
      <span className="text-xs font-medium text-muted-foreground">
        {entry.kind === "draft" ? "You asked for a reply" : "You"}
      </span>
      {entry.text.length > 0 ? (
        <p className="text-sm whitespace-pre-wrap wrap-anywhere">{entry.text}</p>
      ) : null}
    </>
  );
}

/**
 * One box for the thread: a question, or how to write the reply. Nothing typed here reaches the
 * chat app; the reply lands in the draft and goes out only from the conversation's reply box.
 */
function AgentComposer({
  environmentId,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: DelegationDetail;
}) {
  const [text, setText] = useState("");
  // The newest request the thread had recorded when this one was sent; waiting until it moves.
  const [sentAfter, setSentAfter] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const lastAsked = detail.followUps.findLast((entry) => entry.role === "user")?.at ?? null;
  const waiting = sentAfter !== undefined && sentAfter === lastAsked;
  const working = waiting || detail.followUps.at(-1)?.role === "user";

  const submit = async (kind: FollowUp["kind"]) => {
    const value = text.trim();
    if (kind === "question" && value.length === 0) return;
    setSentAfter(lastAsked);
    setError(null);
    setText("");
    const failure = await forkRequest(environmentId, "/inbox/ask", {
      method: "POST",
      body: {
        channelId: detail.delegation.channelId,
        delegationId: detail.delegation.id,
        text: value,
        kind,
      },
    }).then(
      () => null,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
    if (failure !== null) {
      setSentAfter(undefined);
      setText(value);
      setError(failure);
    }
  };

  return (
    <form
      className="flex shrink-0 flex-col gap-2 border-t border-border/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit("question");
      }}
    >
      <Textarea
        aria-label="Message the agent"
        value={text}
        rows={2}
        placeholder="Ask the agent, or say how to write the reply…"
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
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={waiting}
          onClick={() => void submit("draft")}
        >
          Draft reply
        </Button>
        <Button type="submit" size="sm" disabled={waiting || text.trim().length === 0}>
          Ask
        </Button>
      </div>
    </form>
  );
}

/** The thread's status as the sidebar shows it, live from this client's thread state. */
export function ThreadStatus({
  environmentId,
  thread,
}: {
  readonly environmentId: EnvironmentId;
  readonly thread: LinkedThread;
}) {
  const shell = useThreadShell(scopeThreadRef(environmentId, ThreadId.make(thread.threadId)));
  const pill = shell ? resolveThreadStatusPill({ thread: shell }) : null;
  const label = pill?.label ?? THREAD_STATUS_LABELS[thread.status];
  if (label === null) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs",
        pill?.colorClass ?? "text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full", pill?.dotClass ?? "bg-current opacity-60")} />
      {label}
    </span>
  );
}
