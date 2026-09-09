import path from "node:path";

const BY_EXTENSION: Readonly<Record<string, string | undefined>> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  swift: "swift",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  m: "objective-c", mm: "objective-c",
  sh: "shell", zsh: "shell", bash: "shell",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
  xml: "xml", plist: "xml", svg: "xml",
  dockerfile: "dockerfile",
  mk: "makefile",
};

const BY_BASENAME: Readonly<Record<string, string | undefined>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  ".zshrc": "shell", ".bashrc": "shell", ".bash_profile": "shell", ".zprofile": "shell", ".profile": "shell",
};

/** 확장자 기반 소문자 언어 식별자. 모르면 `plaintext`. */
export function languageForPath(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  const byName = BY_BASENAME[base];
  if (byName) return byName;
  if (base.startsWith("dockerfile.")) return "dockerfile";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "plaintext";
  return BY_EXTENSION[base.slice(dot + 1)] ?? "plaintext";
}
