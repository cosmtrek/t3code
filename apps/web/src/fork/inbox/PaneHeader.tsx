import type { ComponentPropsWithoutRef } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";

// Each pane's header is the workspace top bar, as in the chat view, so the page has one row of chrome.
// The pane at the left edge clears the collapsed sidebar's titlebar controls; below 2xl that is
// whichever pane is showing, since the list hides when one opens. The list reaches the right edge
// (and Windows' overlaid controls) only then.
export function PaneHeader({
  edge,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & { readonly edge: "list" | "detail" }) {
  return (
    <header
      className={cn(
        "flex h-(--workspace-topbar-height) shrink-0 items-center gap-1 border-b px-2",
        isElectron && "drag-region",
        edge === "list"
          ? cn(
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
              "@max-2xl/inbox:wco:pr-(--workspace-native-controls-inset)",
            )
          : "wco:pr-(--workspace-native-controls-inset) @max-2xl/inbox:[[data-sidebar-state=collapsed]_&]:pl-(--workspace-titlebar-content-left) @max-2xl/inbox:max-md:[[data-sidebar-state=expanded]_&]:pl-(--workspace-titlebar-content-left)",
        className,
      )}
      {...props}
    />
  );
}
