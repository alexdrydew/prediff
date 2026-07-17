/** React binding for the highlight service: plain text now, HTML when ready. */

import { useEffect, useState } from "react";
import { highlightService } from "./service";

export function useHighlight(code: string, lang: string | null): string | null {
  const [html, setHtml] = useState<string | null>(() =>
    lang === null ? null : (highlightService.peek(lang, code) ?? null),
  );

  useEffect(() => {
    if (lang === null) {
      setHtml(null);
      return;
    }
    const cached = highlightService.peek(lang, code);
    if (cached !== undefined) {
      setHtml(cached);
      return;
    }
    setHtml(null);
    return highlightService.request(lang, code, setHtml);
  }, [code, lang]);

  return html;
}
