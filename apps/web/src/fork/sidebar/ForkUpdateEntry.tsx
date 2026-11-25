import { CircleArrowUpIcon, RefreshCwIcon } from "lucide-react";

import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../../components/ui/menu";
import { SidebarUpdateReleaseNotes } from "../../components/sidebar/SidebarUpdateReleaseNotes";
import {
  SidebarUpdateControl,
  type SidebarUpdate,
} from "../../components/sidebar/SidebarUpdatePill";
import { isElectron } from "../../env";

/**
 * The fork keeps one update entry, in the Settings menu, and marks the gear with a dot.
 * Only a running update keeps its capsule in the footer, since its progress must stay visible.
 */
function hasPendingUpdate(update: SidebarUpdate): boolean {
  return update.showUpdateDetails && update.run === null;
}

export function ForkUpdateFooter({ update }: { readonly update: SidebarUpdate }) {
  if (update.run !== null) return <SidebarUpdateControl update={update} />;
  // The confirm dialog outlives the menu that opened it.
  return update.confirmDialog;
}

export function ForkUpdateDot({ update }: { readonly update: SidebarUpdate }) {
  if (!hasPendingUpdate(update)) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-primary ring-2 ring-sidebar"
    />
  );
}

export function ForkUpdateMenuItems({
  update,
  checkLabel,
  onCheck,
}: {
  readonly update: SidebarUpdate;
  readonly checkLabel: string;
  readonly onCheck: () => void;
}) {
  if (hasPendingUpdate(update)) {
    return (
      <>
        <MenuSeparator />
        <MenuItem
          disabled={update.isInteractionDisabled}
          onClick={() => void update.handleAction()}
        >
          <CircleArrowUpIcon className="text-primary" />
          {update.tooltip}
        </MenuItem>
        {update.showReleaseNotesPopover && update.state ? (
          <MenuSub>
            <MenuSubTrigger>What's new</MenuSubTrigger>
            <MenuSubPopup>
              <div className="p-2">
                <SidebarUpdateReleaseNotes
                  shell={window.desktopBridge}
                  state={update.state}
                  tooltip={update.tooltip}
                />
              </div>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
      </>
    );
  }
  if (!isElectron) return null;
  return (
    <>
      <MenuSeparator />
      <MenuItem onClick={onCheck}>
        <RefreshCwIcon />
        {checkLabel}
      </MenuItem>
    </>
  );
}
