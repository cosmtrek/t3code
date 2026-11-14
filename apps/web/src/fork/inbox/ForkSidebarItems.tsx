import { useNavigate } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem } from "../../components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useInboxOverviews } from "./useInboxOverviews";

/** The Inbox entry in the sidebar footer, shown once an environment has an enabled channel. */
export function ForkSidebarItems({ onNavigate }: { readonly onNavigate: () => void }) {
  const navigate = useNavigate();
  const inboxes = useInboxOverviews();
  if (inboxes.length === 0) return null;
  const pending = inboxes.reduce((sum, inbox) => sum + inbox.pendingCount, 0);
  const label = pending > 0 ? `Inbox, ${pending} waiting for you` : "Inbox";
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
      {pending > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-primary px-1 text-center text-3xs leading-4 font-medium text-primary-foreground tabular-nums"
        >
          {pending > 99 ? "99+" : pending}
        </span>
      ) : null}
    </SidebarMenuItem>
  );
}
