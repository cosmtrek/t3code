import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { SidebarMenuButton, SidebarMenuItem } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useInboxOverviews } from "./useInboxOverviews";

/** The fork's entries in the sidebar footer: Bots always, Inbox once a channel is enabled. */
export function ForkSidebarItems({ onNavigate }: { readonly onNavigate: () => void }) {
  return (
    <>
      <BotsItem onNavigate={onNavigate} />
      <InboxItem onNavigate={onNavigate} />
    </>
  );
}

function BotsItem({ onNavigate }: { readonly onNavigate: () => void }) {
  const navigate = useNavigate();
  return (
    <SidebarMenuItem className="relative shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label="Bots"
              onClick={() => {
                onNavigate();
                void navigate({ to: "/bots" });
              }}
              size="icon"
            >
              <BotGlyph />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Bots</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

function InboxItem({ onNavigate }: { readonly onNavigate: () => void }) {
  const navigate = useNavigate();
  const inboxes = useInboxOverviews();
  if (inboxes.length === 0) return null;
  const unread = inboxes.reduce((sum, inbox) => sum + inbox.unreadCount, 0);
  const label = unread > 0 ? `Inbox, ${unread} unread` : "Inbox";
  return (
    <SidebarMenuItem className="relative shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              onClick={() => {
                onNavigate();
                void navigate({ to: "/inbox" });
              }}
              size="icon"
            >
              <InboxGlyph />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      {unread > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-3xs leading-4 font-medium text-primary-foreground tabular-nums"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </SidebarMenuItem>
  );
}

/** Drawn on lucide's 24px grid and stroke so they sit beside the other footer icons. */
function Glyph({ children }: { readonly children: ReactNode }) {
  return (
    <svg
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}

function BotGlyph() {
  return (
    <Glyph>
      <rect x="2" y="3" width="20" height="18" rx="7" />
      <path d="M8.5 10.5v3" />
      <path d="M15.5 10.5v3" />
    </Glyph>
  );
}

function InboxGlyph() {
  return (
    <Glyph>
      <path d="M9 3h6a7 7 0 0 1 7 7v1a7 7 0 0 1-7 7h-3l-5 3.5V17.6A7 7 0 0 1 2 11v-1a7 7 0 0 1 7-7z" />
      <path d="M8 10.5h8" />
    </Glyph>
  );
}
