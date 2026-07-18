import type { ReactElement } from "react";
/**
 * A line of code: renders as plain text instantly; swaps in worker-produced
 * highlight HTML when it arrives. Highlighting never gates rendering.
 * Word-level diff marks (spec §3.2) are overlaid either into the highlight
 * HTML (entity-aware) or over escaped plain text while highlighting is pending.
 */

import { memo } from "react";
import { useHighlight } from "../../highlight/useHighlight";
import { markHighlightedHtml } from "../../lib/wordDiff";

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export const CodeText = memo(function CodeText({
  text,
  lang,
  marks,
}: {
  text: string;
  lang: string | null;
  /** Char ranges [start, end) to wrap in word-diff marks. */
  marks?: Array<[number, number]> | undefined;
}): ReactElement {
  const html = useHighlight(text, lang);
  // hljs escapes its input; the HTML is inert markup around the original text.
  if (marks !== undefined && marks.length > 0) {
    const base = html ?? escapeHtml(text);
    return <span dangerouslySetInnerHTML={{ __html: markHighlightedHtml(base, marks) }} />;
  }
  return html !== null ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <span>{text}</span>;
});
