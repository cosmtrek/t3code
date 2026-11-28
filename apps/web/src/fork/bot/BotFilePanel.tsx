import { useAtomValue } from "@effect/atom-react";
import { DraftId } from "../../composerDraftStore";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { isHostPath } from "@t3tools/shared/path";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import FilePreviewPanel from "../../components/files/FilePreviewPanel";
import { RightPanelResizeHandle } from "../../components/preview/RightPanelResizeHandle";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "../../hooks/useResizableWidth";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { cn } from "../../lib/utils";
import { IconAction } from "../inbox/IconAction";
import { PaneHeader } from "../inbox/PaneHeader";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";

export function useBotFiles(
  environmentId: EnvironmentId,
  botId: string,
  workThreadId: string | null,
  cwd: string | undefined,
) {
  // A draft key only owns local UI state; preview assets use the workspace resource branch.
  const threadId = ThreadId.make(workThreadId ?? `bot-files:${botId}`);
  const ref = { environmentId, threadId };
  const panel = useRightPanelStore((state) => selectThreadRightPanelState(state.byThreadKey, ref));
  const [profile, setProfile] = useState(true);
  const previousRef = useRef(ref);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- transfer local tabs to the real thread store when the bot starts its first turn
  useEffect(() => {
    const previous = previousRef.current;
    const nextRef = scopeThreadRef(environmentId, threadId);
    previousRef.current = nextRef;
    if (previous.environmentId !== environmentId || previous.threadId === threadId) return;
    const store = useRightPanelStore.getState();
    const old = selectThreadRightPanelState(store.byThreadKey, previous);
    for (const file of old.surfaces) {
      if (file.kind === "file")
        store.openFile(nextRef, file.relativePath, file.revealLine ?? undefined);
    }
    const active = old.surfaces.find((surface) => surface.id === old.activeSurfaceId);
    if (active?.kind === "file") {
      const migrated = selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        nextRef,
      );
      const selected = migrated.surfaces.find(
        (surface) => surface.kind === "file" && surface.relativePath === active.relativePath,
      );
      if (selected) store.activateSurface(nextRef, selected.id);
    }
  }, [environmentId, threadId]);
  const files = panel.surfaces.filter((surface) => surface.kind === "file");
  const selected = profile
    ? null
    : (files.find((file) => file.id === panel.activeSurfaceId) ?? null);
  return {
    ref,
    files,
    selected,
    showProfile: () => setProfile(true),
    open: (path: string, line?: number) => {
      useRightPanelStore
        .getState()
        .openFile(ref, cwd ? resolvePathLinkTarget(path, cwd) : path, line);
      setProfile(false);
    },
    select: (id: string) => {
      useRightPanelStore.getState().activateSurface(ref, id);
      setProfile(false);
    },
    close: (id: string) => {
      const index = files.findIndex((file) => file.id === id);
      const remaining = files.filter((file) => file.id !== id);
      useRightPanelStore.getState().closeSurface(ref, id);
      const next = remaining[Math.min(index, remaining.length - 1)];
      if (next) useRightPanelStore.getState().activateSurface(ref, next.id);
      setProfile(!next);
      return remaining.length;
    },
  };
}

export function BotFilePanel(props: {
  readonly files: ReturnType<typeof useBotFiles>;
  readonly cwd: string | undefined;
  readonly name: string;
  readonly hasThread: boolean;
  readonly overlay: boolean;
  readonly onHide: () => void;
  readonly onCloseFile: (id: string) => void;
  readonly children: ReactNode;
}) {
  const { files, selected, ref } = props.files;
  const width = useResizableWidth({
    storageKey: selected ? "t3code:bots-file-width" : "t3code:bots-profile-width",
    defaultWidth: selected ? 480 : 320,
    minWidth: 280,
    maxWidth: selected ? 960 : 560,
    edge: "left",
  });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const config = useAtomValue(serverEnvironment.configValueAtom(ref.environmentId));
  const path = selected?.relativePath;
  const cwd =
    props.cwd ??
    (path && isHostPath(path)
      ? path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
      : undefined);
  return (
    <aside
      className={cn(
        "relative flex w-(--resizable-width) max-w-full min-w-70 flex-col border-l bg-background",
        props.overlay && "absolute inset-y-0 right-0 z-20 shadow-lg",
      )}
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width.width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle handlers={width.handlers} label={"Resize panel"} />
      <PaneHeader edge="detail">
        {files.length === 0 ? (
          <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{"Profile"}</h2>
        ) : (
          <div
            role="tablist"
            aria-label={"Open files"}
            onKeyDown={(event) => {
              if (
                !(event.target instanceof HTMLElement) ||
                event.target.getAttribute("role") !== "tab"
              )
                return;
              const tabs = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
              );
              const index = tabs.indexOf(event.target as HTMLButtonElement);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              tabs[next]?.focus();
              tabs[next]?.click();
            }}
            className="flex min-w-0 flex-1 overflow-x-auto"
          >
            <button
              type="button"
              role="tab"
              aria-selected={!selected}
              tabIndex={selected ? -1 : 0}
              onClick={props.files.showProfile}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2 text-xs",
                !selected ? "border-primary" : "border-transparent",
              )}
            >
              {"Profile"}
            </button>
            {files.map((file) => (
              <div
                key={file.id}
                className={cn(
                  "flex shrink-0 items-center border-b-2",
                  selected?.id === file.id ? "border-primary" : "border-transparent",
                )}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="tab"
                        aria-selected={selected?.id === file.id}
                        tabIndex={selected?.id === file.id ? 0 : -1}
                        onClick={() => props.files.select(file.id)}
                        className="max-w-48 truncate px-2 py-2 text-xs"
                      />
                    }
                  >
                    {file.relativePath.split(/[\\/]/).at(-1)}
                  </TooltipTrigger>
                  <TooltipPopup>{file.relativePath}</TooltipPopup>
                </Tooltip>
                <IconAction
                  label={`Close ${file.relativePath}`}
                  onClick={() => props.onCloseFile(file.id)}
                >
                  <XIcon />
                </IconAction>
              </div>
            ))}
          </div>
        )}
        <IconAction label={"Hide panel"} onClick={props.onHide}>
          <XIcon />
        </IconAction>
      </PaneHeader>
      {selected ? (
        cwd ? (
          <FilePreviewPanel
            environmentId={ref.environmentId}
            cwd={cwd}
            projectName={props.name}
            relativePath={resolvePathLinkTarget(selected.relativePath, cwd)}
            threadRef={ref}
            composerDraftTarget={
              props.hasThread ? ref : DraftId.make(`bot-files:${ref.environmentId}:${ref.threadId}`)
            }
            keybindings={keybindings}
            availableEditors={config?.availableEditors ?? []}
            openInShortcutEnabled
            revealLine={selected.revealLine}
            revealRequestId={selected.revealRequestId}
            onOpenFile={props.files.open}
            onNavigateFolder={(path) => props.files.open(path)}
            folderTrail={undefined}
            onPendingChange={() => undefined}
            selectedFilePending={false}
            workspaceMutationId={null}
          />
        ) : (
          <p role="alert" className="p-4 text-sm text-muted-foreground">
            {"The workspace folder is unavailable."}
          </p>
        )
      ) : (
        props.children
      )}
    </aside>
  );
}
