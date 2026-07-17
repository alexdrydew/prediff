import type { ReactElement } from "react";
/**
 * A line of code: renders as plain text instantly; swaps in worker-produced
 * highlight HTML when it arrives. Highlighting never gates rendering.
 */

import { memo } from "react";
import { useHighlight } from "../../highlight/useHighlight";

export const CodeText = memo(function CodeText({
  text,
  lang,
}: {
  text: string;
  lang: string | null;
}): ReactElement {
  const html = useHighlight(text, lang);
  // hljs escapes its input; the HTML is inert markup around the original text.
  return html !== null ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <span>{text}</span>;
});
