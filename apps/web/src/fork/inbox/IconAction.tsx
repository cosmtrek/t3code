import type { ComponentProps } from "react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/** The inbox's icon-only button: one size and look, named by its tooltip and label. */
export function IconAction({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "size" | "aria-label"> & { readonly label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label={label} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
