import type { ComponentProps, KeyboardEvent, ReactNode } from "react";

import { ComposerSurface } from "../../components/chat/ComposerSurface";
import { composerRequiresModifier } from "../../composer-logic";
import { useClientSettings } from "../../hooks/useSettings";
import { isMacPlatform } from "../../lib/utils";
import { Spinner } from "../../components/ui/spinner";
import { Textarea } from "../../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";

/**
 * The inbox's one reply box, shaped like T3 Code's composer: what the reply answers and its files
 * above the text, the status and actions in a row along the bottom edge, Send in the corner.
 */
export function ReplyBox({
  above,
  status,
  actions,
  sending,
  canSend,
  ...textarea
}: Omit<ComponentProps<typeof Textarea>, "rows" | "unstyled" | "className"> & {
  readonly above?: ReactNode;
  /** One line at the bottom-left: an error, or who the reply notifies. */
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly sending: boolean;
  readonly canSend: boolean;
}) {
  const sendKey = useSendKey();
  return (
    // The pane sets the width; the chat column cap would leave it narrower than the messages.
    <ComposerSurface.Shell className="max-w-none">
      <ComposerSurface.Host>
        <div className="relative z-10 flex flex-col">
          {above ? <div className="flex flex-col gap-1.5 px-4 pt-2.5">{above}</div> : null}
          <div className="px-1 pt-1.5 [&_textarea]:resize-none">
            <Textarea {...textarea} unstyled rows={1} />
          </div>
          <div className="flex min-w-0 items-center gap-1 px-2.5 pb-2.5">
            <div className="min-w-0 flex-1 truncate text-xs">{status}</div>
            {actions}
            <SendButton
              sending={sending}
              disabled={!canSend || sending}
              shortcut={sendKey.label(String(textarea.value ?? ""))}
            />
          </div>
        </div>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
  );
}

/**
 * Which keys send, by the same Send shortcut setting as T3 Code's composer: Enter, or Cmd/Ctrl+Enter
 * (always, or once the text has a line break). Cmd/Ctrl+Enter always sends; an IME's Enter picks its word.
 */
export function useSendKey() {
  const sendShortcut = useClientSettings((settings) => settings.sendShortcut);
  const needsModifier = (text: string) => composerRequiresModifier(sendShortcut, text);
  return {
    isSend: (event: KeyboardEvent<HTMLTextAreaElement>) =>
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing &&
      // Safari ends composition before keydown and reports the IME's Enter as 229.
      event.keyCode !== 229 &&
      (event.metaKey || event.ctrlKey || !needsModifier(event.currentTarget.value)),
    label: (text: string) =>
      needsModifier(text) ? `${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+"}Enter` : "Enter",
  };
}

function SendButton({
  sending,
  disabled,
  shortcut,
}: {
  readonly sending: boolean;
  readonly disabled: boolean;
  readonly shortcut: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="submit"
            aria-label={sending ? "Sending" : "Send"}
            disabled={disabled}
            className="ms-1 flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs transition-colors duration-150 enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-control-highlight hover:bg-message-action-hover disabled:bg-foreground/12 disabled:text-muted-foreground disabled:shadow-none [&_svg]:pointer-events-none"
          />
        }
      >
        {sending ? (
          <Spinner size="sm" aria-hidden />
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">Send · {shortcut}</TooltipPopup>
    </Tooltip>
  );
}
