import type { AssistantCitation } from "@t3tools/contracts";
import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";

import { ComposerSurface } from "../../components/chat/ComposerSurface";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../../components/ComposerPromptEditorTiptap";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../../components/composerContextPresentation";
import {
  composerRequiresModifier,
  extendReplacementRangeForTrailingSpace,
  formatAssistantCitationForComposer,
  replaceTextRange,
} from "../../composer-logic";
import { useClientSettings } from "../../hooks/useSettings";
import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";
import { isMacPlatform } from "../../lib/utils";
import { SendButton } from "../inbox/ReplyBox";

export interface BotComposerHandle {
  /** Puts the citation at the caret and opens its comment beside the cited text, as a thread does. */
  cite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}

/**
 * The bot chat's message box: T3 Code's prompt editor, so citations behave as in a thread, in the
 * inbox's reply-box frame. It sends the prompt as written, citation links and all.
 */
export function BotComposer({
  ref,
  placeholder,
  status,
  sending,
  onSend,
}: {
  readonly ref: Ref<BotComposerHandle>;
  readonly placeholder: string;
  readonly status?: ReactNode;
  readonly sending: boolean;
  /** Resolves true once sent, which clears the box. */
  readonly onSend: (prompt: string) => Promise<boolean>;
}) {
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [prompt, setPrompt] = useState("");
  // Saving a citation comment and sending happen in one event, before a render would show it.
  const promptRef = useRef("");
  const write = (next: string) => {
    promptRef.current = next;
    setPrompt(next);
  };
  const [cursor, setCursor] = useState(0);
  const sendShortcut = useClientSettings((settings) => settings.sendShortcut);
  const needsModifier = composerRequiresModifier(sendShortcut, prompt);
  const canSend = prompt.trim() !== "" && !sending;

  const send = () => {
    const text = promptRef.current.trim();
    if (text === "" || sending) return false;
    void onSend(text).then((sent) => {
      if (!sent) return;
      write("");
      setCursor(0);
    });
    return true;
  };

  useImperativeHandle(ref, () => ({
    cite: (citation, sourceAnchor) => {
      const editor = editorRef.current;
      if (!editor) return false;
      const snapshot = editor.readSnapshot();
      const at = snapshot.expandedCursor;
      const text = formatAssistantCitationForComposer(citation);
      const before = at > 0 && !/\s/.test(snapshot.value[at - 1] ?? "");
      const end = extendReplacementRangeForTrailingSpace(snapshot.value, at, text);
      const next = replaceTextRange(snapshot.value, at, end, before ? ` ${text}` : text);
      editor.requestCitationComment({
        previousValue: snapshot.value,
        value: next.text,
        citationStart: at + (before ? 1 : 0),
        sourceAnchor,
        insertedSpaces: { before, after: end === at },
      });
      write(next.text);
      return true;
    },
  }));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <ComposerSurface.Shell className="max-w-none">
        <ComposerSurface.Host>
          <div className="relative z-10 flex flex-col">
            <div className="px-1 pt-1.5">
              <ComposerPromptEditor
                editorRef={editorRef}
                ariaLabel={placeholder}
                value={prompt}
                cursor={cursor}
                contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
                skills={[]}
                disabled={false}
                placeholder={placeholder}
                onChange={(nextValue, nextCursor) => {
                  write(nextValue);
                  setCursor(nextCursor);
                }}
                onCommandKeyDown={(key, event) => {
                  if (key !== "Enter" || event.shiftKey || event.altKey || event.isComposing) {
                    return false;
                  }
                  if (!event.metaKey && !event.ctrlKey && needsModifier) return false;
                  send();
                  return true;
                }}
                onCitationSubmitAndSend={send}
                onPaste={() => {}}
              />
            </div>
            <div className="flex min-w-0 items-center gap-1 px-2.5 pb-2.5">
              <div className="min-w-0 flex-1 truncate text-xs">{status}</div>
              <SendButton
                sending={sending}
                disabled={!canSend}
                label="Send"
                shortcut={
                  needsModifier
                    ? `${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl+"}Enter`
                    : "Enter"
                }
              />
            </div>
          </div>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
}
