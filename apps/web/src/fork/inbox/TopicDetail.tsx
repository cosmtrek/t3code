import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon, SendIcon } from "lucide-react";
import { useState } from "react";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";

import { resolveThreadStatusPill } from "../../components/Sidebar.logic";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import {
  ForkApiError,
  forkRequest,
  forkUrl,
  renewForkAccess,
  useForkAccess,
} from "../forkApiAccess";
import { formatTimestamp } from "../presentation";
import type {
  InboxMessage,
  LinkedThread,
  SendResult,
  TopicDetail as TopicDetailData,
} from "../types";
import {
  nameOrUnknown,
  nextReplyText,
  sameDraftSource,
  skippedNotice,
  type DraftSource,
} from "./inboxView";

/** The sidebar's words, for when the thread is not in this client's sidebar state. */
const THREAD_STATUS_LABELS: Readonly<Record<LinkedThread["status"], string | null>> = {
  running: "Working",
  idle: "Done",
  archived: "Archived",
  deleted: "Thread deleted",
  unknown: null,
};

export function TopicDetail({
  environmentId,
  detail,
  sendingOff,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
  readonly sendingOff: boolean;
}) {
  const { item } = detail;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {detail.truncatedAtPages !== null ? (
          <p className="mb-3 text-xs text-muted-foreground">
            Showing the first {detail.truncatedAtPages} pages.
          </p>
        ) : null}
        {skippedNotice(detail.skipped) ? (
          <p className="mb-3 text-xs text-warning">{skippedNotice(detail.skipped)}</p>
        ) : null}
        <ol className="flex flex-col gap-3">
          {detail.messages.map((message) => (
            <li key={message.id}>
              <MessageView
                environmentId={environmentId}
                channelId={item.channelId}
                message={message}
              />
            </li>
          ))}
        </ol>
        {item.thread || detail.conclusion !== null || detail.previousThreads.length > 0 ? (
          <ThreadCard environmentId={environmentId} detail={detail} />
        ) : null}
      </div>
      <Composer
        key={item.id}
        environmentId={environmentId}
        detail={detail}
        disabled={sendingOff || !detail.canSend}
      />
    </div>
  );
}

function MessageView({
  environmentId,
  channelId,
  message,
}: {
  readonly environmentId: EnvironmentId;
  readonly channelId: string;
  readonly message: InboxMessage;
}) {
  const access = useForkAccess(environmentId);
  return (
    <article className="flex min-w-0 flex-col gap-1">
      <header className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className={cn("truncate font-medium", message.author.isSelf && "text-primary")}>
          {nameOrUnknown(message.author.name)}
          {message.author.isSelf ? " (you)" : ""}
        </span>
        <time className="shrink-0 text-muted-foreground" dateTime={message.createdAt}>
          {formatTimestamp(message.createdAt)}
        </time>
        {message.mentionsSelf ? <span className="shrink-0 text-warning">@you</span> : null}
      </header>
      {message.text.trim() ? (
        <p className="text-sm break-words whitespace-pre-wrap">{message.text}</p>
      ) : null}
      {message.richSummary ? (
        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <p className="break-words whitespace-pre-wrap">{message.richSummary}</p>
          {message.openUrl ? (
            <a
              className="mt-1 inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
              href={message.openUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Open in app <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      ) : null}
      {message.attachments.map((attachment) =>
        attachment.kind === "image" && access !== null ? (
          <MediaImage
            key={attachment.key}
            environmentId={environmentId}
            access={access}
            alt={attachment.name}
            path={`/inbox/media?${new URLSearchParams({ channelId, messageId: message.id, key: attachment.key }).toString()}`}
          />
        ) : (
          <span key={attachment.key} className="text-xs text-muted-foreground">
            {attachment.kind === "image" ? "Image" : "File"}: {attachment.name}
          </span>
        ),
      )}
      {message.links.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {message.links.map((link) => (
            <li key={link} className="min-w-0 truncate">
              <a
                className="text-muted-foreground underline-offset-2 hover:underline"
                href={link}
                target="_blank"
                rel="noreferrer noopener"
              >
                {link}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

/** The URL carries a ticket that can expire; one failed load renews it and tries once more. */
function MediaImage({
  environmentId,
  access,
  alt,
  path,
}: {
  readonly environmentId: EnvironmentId;
  readonly access: DeviceHubAccess;
  readonly alt: string;
  readonly path: string;
}) {
  const [renewed, setRenewed] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed)
    return <span className="text-xs text-muted-foreground">Image: {alt} (not loaded)</span>;
  return (
    <img
      alt={alt}
      loading="lazy"
      className="max-h-72 max-w-full self-start rounded-md border border-border/60 object-contain"
      src={forkUrl(access, path)}
      onError={() => {
        if (renewed) {
          setFailed(true);
          return;
        }
        setRenewed(true);
        renewForkAccess(environmentId);
      }}
    />
  );
}

function ThreadCard({
  environmentId,
  detail,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
}) {
  const navigate = useNavigate();
  const thread = detail.item.thread;
  const live = thread !== null && thread.status !== "deleted" ? thread : null;
  return (
    <section className="mt-4 flex flex-col gap-2 rounded-lg border border-border/70 p-3">
      <header className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
          {live
            ? (live.title ?? "Linked thread")
            : detail.conclusion !== null
              ? "Earlier conclusion"
              : "Thread deleted"}
        </h3>
        {live ? (
          <>
            <ThreadStatus environmentId={environmentId} thread={live} />
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId, threadId: ThreadId.make(live.threadId) },
                })
              }
            >
              Open
            </Button>
          </>
        ) : null}
      </header>
      {detail.conclusion !== null ? (
        <p className="max-h-60 overflow-y-auto text-xs break-words whitespace-pre-wrap">
          {detail.conclusion}
        </p>
      ) : live?.status === "idle" ? (
        <p className="text-xs text-muted-foreground">Finished without a conclusion</p>
      ) : null}
    </section>
  );
}

/** The thread's status as the sidebar shows it, live from this client's thread state. */
function ThreadStatus({
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

function Composer({
  environmentId,
  detail,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: TopicDetailData;
  readonly disabled: boolean;
}) {
  const source: DraftSource | null =
    detail.draft === null
      ? null
      : { threadId: detail.item.thread?.threadId ?? null, text: detail.draft.trim() };
  const [shown, setShown] = useState(source);
  const [text, setText] = useState(source?.text ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sameDraftSource(source, shown)) {
    setShown(source);
    setText(nextReplyText(text, shown, source));
  }

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await forkRequest<SendResult>(environmentId, "/inbox/send", {
        method: "POST",
        body: {
          channelId: detail.item.channelId,
          conversationId: detail.item.conversationId,
          topicId: detail.item.topicId,
          text,
        },
      });
      setText("");
      setSending(false);
      if (result.archived === false) {
        toastManager.add({
          type: "warning",
          title: "Sent, but the copy in the item folder could not be saved.",
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
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {shown !== null && text === shown.text ? (
        <Badge variant="info" className="self-start">
          Draft
        </Badge>
      ) : null}
      <Textarea
        aria-label="Reply"
        value={text}
        rows={3}
        disabled={disabled}
        placeholder={disabled ? "Sending is off" : "Reply in this topic"}
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
