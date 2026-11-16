import type { EnvironmentId } from "@t3tools/contracts";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import { DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { forkUrl, renewForkAccess, renewStaleForkAccess, useForkAccess } from "../forkApiAccess";
import { formatTimestamp } from "../presentation";
import type { InboxMessage } from "../types";
import { nameOrUnknown } from "./inboxView";

export function MessageView({
  environmentId,
  channelId,
  message,
  showAuthor,
  quote,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly channelId: string;
  readonly message: InboxMessage;
  readonly showAuthor: boolean;
  /** The message this one answers, shown above it as the chat app does. */
  readonly quote?: string | null;
  /** Shown under the message, such as the topic's replies and state. */
  readonly children?: ReactNode;
}) {
  const access = useForkAccess(environmentId);
  const self = message.author.isSelf;
  const hasText = message.text.trim().length > 0;
  if (isSystemNotice(message)) {
    return (
      <p className="self-center px-3 text-center text-xs text-muted-foreground">
        {message.richSummary} ·{" "}
        <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time>
      </p>
    );
  }
  return (
    <article
      className={cn(
        "flex max-w-[85%] min-w-0 flex-col gap-1",
        self ? "items-end self-end" : "items-start self-start",
      )}
    >
      <header className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
        {showAuthor && !self ? (
          <span className="truncate font-medium text-foreground">
            {nameOrUnknown(message.author.name)}
          </span>
        ) : null}
        <time className="shrink-0" dateTime={message.createdAt}>
          {formatTimestamp(message.createdAt)}
        </time>
        {message.mentionsSelf ? <span className="shrink-0 text-warning">@you</span> : null}
      </header>
      {quote ? (
        <p className="max-w-full truncate border-s-2 border-border ps-2 text-xs text-muted-foreground">
          {quote}
        </p>
      ) : null}
      {hasText ? (
        <p
          className={cn(
            "rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap wrap-anywhere",
            self ? "rounded-tr-sm bg-primary text-primary-foreground" : "rounded-tl-sm bg-muted",
          )}
        >
          {message.text}
        </p>
      ) : null}
      {message.richSummary ? (
        <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <p className="whitespace-pre-wrap wrap-anywhere">{message.richSummary}</p>
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
      {message.attachments.map((attachment) => {
        if (access === null) {
          return (
            <span
              key={attachment.key}
              className="rounded-xl border border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
            >
              {attachment.kind === "image" ? "Image" : "File"}: {attachment.name}
            </span>
          );
        }
        const path = `/inbox/media?${new URLSearchParams({ channelId, messageId: message.id, key: attachment.key }).toString()}`;
        if (attachment.kind === "image") {
          return (
            <MediaImage
              key={attachment.key}
              environmentId={environmentId}
              access={access}
              alt={attachment.name}
              path={path}
            />
          );
        }
        return (
          <div key={attachment.key} className="flex max-w-full min-w-0 flex-col gap-1">
            {VIDEO_NAME.test(attachment.name) ? (
              <MediaVideo environmentId={environmentId} access={access} path={path} />
            ) : null}
            <MediaLink
              environmentId={environmentId}
              access={access}
              name={attachment.name}
              path={path}
            />
          </div>
        );
      })}
      {message.links.length > 0 ? (
        <ul className="flex max-w-full min-w-0 flex-col gap-0.5 text-xs">
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
      {!hasText &&
      !message.richSummary &&
      message.attachments.length === 0 &&
      message.links.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
          Unsupported message
          {message.openUrl ? (
            <>
              {" · "}
              <a
                className="text-foreground underline-offset-2 hover:underline"
                href={message.openUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open in app
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {children}
    </article>
  );
}

/** Feishu's adapter writes join/leave notices as author "1" with only a summary line. */
const SYSTEM_AUTHOR_ID = "1";

function isSystemNotice(message: InboxMessage): boolean {
  return (
    message.author.id === SYSTEM_AUTHOR_ID &&
    message.text.trim().length === 0 &&
    message.attachments.length === 0 &&
    message.links.length === 0 &&
    !!message.richSummary
  );
}

const VIDEO_NAME = /\.(mp4|mov|m4v|webm)$/i;

/** The server names the download from `name`; `download` alone is ignored across origins. */
function MediaLink({
  environmentId,
  access,
  name,
  path,
}: {
  readonly environmentId: EnvironmentId;
  readonly access: DeviceHubAccess;
  readonly name: string;
  readonly path: string;
}) {
  const renew = () => renewStaleForkAccess(environmentId, access);
  return (
    <a
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 self-start rounded-xl border border-border/60 px-3 py-1.5 text-xs text-foreground underline-offset-2 hover:underline"
      href={forkUrl(access, `${path}&${new URLSearchParams({ name }).toString()}`)}
      download={name}
      target="_blank"
      rel="noreferrer noopener"
      onPointerEnter={renew}
      onFocus={renew}
    >
      <DownloadIcon className="size-3.5 shrink-0" />
      <span className="truncate">{name}</span>
    </a>
  );
}

/** Loads nothing until played, so a long topic of videos costs no bandwidth. */
function MediaVideo({
  environmentId,
  access,
  path,
}: {
  readonly environmentId: EnvironmentId;
  readonly access: DeviceHubAccess;
  readonly path: string;
}) {
  const [renewed, setRenewed] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <video
      controls
      preload="none"
      className="max-h-72 max-w-full rounded-xl border border-border/60"
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
      className="max-h-72 max-w-full rounded-xl border border-border/60 object-contain"
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
