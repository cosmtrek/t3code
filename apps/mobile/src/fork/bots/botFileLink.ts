import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { fileRoutePathSegments, resolveFileLinkPath } from "../../features/files/filePath";

export function botFileLink(
  href: string,
  context: {
    environmentId: string;
    workThreadId: string | null;
    workspacePath: string;
  },
) {
  const link = resolveMarkdownLinkPresentation(href);
  if (link.kind !== "file") return null;
  const path = resolveFileLinkPath(context.workspacePath, link.path);
  if (path === null) return null;
  const common = {
    environmentId: context.environmentId,
    path: fileRoutePathSegments(path),
    ...(link.line ? { line: String(link.line) } : {}),
  };
  if (context.workThreadId !== null)
    return {
      screen: "ThreadFile" as const,
      params: { ...common, threadId: context.workThreadId },
    };
  if (!context.workspacePath) return null;
  return {
    screen: "NewTaskFile" as const,
    params: { ...common, cwd: context.workspacePath, projectName: context.workspacePath },
  };
}
