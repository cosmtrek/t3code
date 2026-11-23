import { useNavigate } from "@tanstack/react-router";
import { BotMessageSquareIcon, InboxIcon } from "lucide-react";

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
              <BotMessageSquareIcon />
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
              <InboxIcon />
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
