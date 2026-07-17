/** File extension → highlight.js language id (only ids the worker can load). */

const EXT_TO_LANG: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  jsonc: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  markdown: "markdown",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  lua: "lua",
  pl: "perl",
  r: "r",
  scala: "scala",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
};

const BASENAME_TO_LANG: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

export function languageForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const fromBase = BASENAME_TO_LANG[base];
  if (fromBase !== undefined) return fromBase;
  const dot = base.lastIndexOf(".");
  if (dot === -1) return null;
  return EXT_TO_LANG[base.slice(dot + 1)] ?? null;
}
