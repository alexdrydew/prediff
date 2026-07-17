/**
 * Syntax highlighting worker: highlight.js core with per-language grammars
 * loaded lazily via dynamic import (each becomes its own chunk). Lines are
 * highlighted individually — good enough for diff lines, and it keeps the
 * protocol trivially batchable. hljs escapes all input, so the returned HTML
 * is safe to inject.
 */

import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";

export interface HighlightRequest {
  id: number;
  lang: string;
  lines: string[];
}

export interface HighlightResponse {
  id: number;
  /** null per line when the language is unavailable or highlighting failed. */
  html: (string | null)[];
}

type LanguageLoader = () => Promise<{ default: LanguageFn }>;

/** Statically-analyzable loader map: each grammar is a lazy chunk. */
const LOADERS: Readonly<Record<string, LanguageLoader>> = {
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  java: () => import("highlight.js/lib/languages/java"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  swift: () => import("highlight.js/lib/languages/swift"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  php: () => import("highlight.js/lib/languages/php"),
  bash: () => import("highlight.js/lib/languages/bash"),
  json: () => import("highlight.js/lib/languages/json"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  ini: () => import("highlight.js/lib/languages/ini"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  less: () => import("highlight.js/lib/languages/less"),
  xml: () => import("highlight.js/lib/languages/xml"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  sql: () => import("highlight.js/lib/languages/sql"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  lua: () => import("highlight.js/lib/languages/lua"),
  perl: () => import("highlight.js/lib/languages/perl"),
  r: () => import("highlight.js/lib/languages/r"),
  scala: () => import("highlight.js/lib/languages/scala"),
  dart: () => import("highlight.js/lib/languages/dart"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
};

/** null = known-unavailable; Promise = loading. */
const loaded = new Map<string, Promise<boolean>>();

function ensureLanguage(lang: string): Promise<boolean> {
  let p = loaded.get(lang);
  if (!p) {
    const loader = LOADERS[lang];
    p = loader
      ? loader().then(
          (mod) => {
            hljs.registerLanguage(lang, mod.default);
            return true;
          },
          () => false,
        )
      : Promise.resolve(false);
    loaded.set(lang, p);
  }
  return p;
}

function highlightLine(lang: string, line: string): string | null {
  if (line.length === 0) return "";
  if (line.length > 2_000) return null; // pathological line; plain text is fine
  try {
    return hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  const { id, lang, lines } = event.data;
  void ensureLanguage(lang).then((available) => {
    const html = available ? lines.map((line) => highlightLine(lang, line)) : lines.map(() => null);
    const response: HighlightResponse = { id, html };
    self.postMessage(response);
  });
};
