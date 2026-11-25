import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";

import { findAssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";

const HIGHLIGHT = "t3-assistant-citation";
const OPACITY = "--assistant-citation-highlight-opacity";

/**
 * When `target` is a citation's link (a sent card or a composer chip), scrolls to the quoted text
 * in this page and highlights it as a thread does, and returns true. The link would open a thread.
 */
export function revealCitedText(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const holder = target.closest("a")?.closest<HTMLElement>("[data-markdown-copy]");
  const citation = collectAssistantCitations(holder?.dataset.markdownCopy ?? "")[0]?.citation;
  if (!citation) return false;
  const anchor = findAssistantCitationSourceAnchor(document, citation);
  if (!anchor) return true;
  anchor.source.scrollIntoView({ block: "center", behavior: "smooth" });
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return true;
  const highlight = new Highlight(anchor.range);
  CSS.highlights.set(HIGHLIGHT, highlight);
  const fade = anchor.source.animate(
    [{ [OPACITY]: 0.45 }, { [OPACITY]: 0.45, offset: 0.7 }, { [OPACITY]: 0 }],
    {
      duration: 2_500,
      easing: "ease-out",
    },
  );
  fade.onfinish = () => {
    if (CSS.highlights.get(HIGHLIGHT) === highlight) CSS.highlights.delete(HIGHLIGHT);
  };
  return true;
}
