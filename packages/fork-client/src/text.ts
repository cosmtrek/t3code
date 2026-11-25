/** Markdown as plain text; `_` inside a word, as in `plugin_gw`, is not emphasis. */
export const plainPreview = (text: string) =>
  text
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>)\s+/gm, "")
    .replace(/[`*]|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .trim();
