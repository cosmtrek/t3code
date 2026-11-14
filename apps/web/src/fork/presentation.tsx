import { cn } from "../lib/utils";
import type { ChannelStatus } from "./types";

export const CHANNEL_STATUS_LABELS: Readonly<Record<ChannelStatus, string>> = {
  disabled: "Off",
  token_missing: "Token missing",
  unreachable: "Adapter unreachable",
  unauthorized: "Token refused",
  incompatible: "Protocol mismatch",
  needs_login: "Sign-in needed",
  collector_stopped: "Collector stopped",
  online: "Online",
};

const DOT_CLASS: Readonly<Record<ChannelStatus, string>> = {
  disabled: "bg-muted-foreground/40",
  token_missing: "bg-destructive",
  unauthorized: "bg-destructive",
  incompatible: "bg-destructive",
  needs_login: "bg-destructive",
  unreachable: "bg-warning",
  collector_stopped: "bg-warning",
  online: "bg-success",
};

/** Statuses whose banner shows how long they have lasted. */
export const TIMED_STATUSES: ReadonlySet<ChannelStatus> = new Set([
  "unreachable",
  "collector_stopped",
]);

export function ChannelStatusDot({
  status,
  className,
}: {
  readonly status: ChannelStatus;
  readonly className?: string;
}) {
  return (
    <span
      role="img"
      aria-label={CHANNEL_STATUS_LABELS[status]}
      className={cn("inline-block size-2 shrink-0 rounded-full", DOT_CLASS[status], className)}
    />
  );
}

/** "3m", "5h", "2d" — wait times and outage lengths. */
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatSince(iso: string | null, now = Date.now()): string {
  if (iso === null) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const span = formatSpan(now - at);
  return span === "now" ? "just now" : `${span} ago`;
}

export function formatTimestamp(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : at.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
