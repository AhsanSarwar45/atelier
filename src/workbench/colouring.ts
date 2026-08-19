/**
 * Colouring code the agent read, wrote or ran.
 *
 * A chat is mostly code, and every piece of it was one grey block: a command, a
 * file being read, the two sides of a change. The colours are the same ones the
 * markdown body already paints a fenced block with (`highlight.js`, the
 * `github-dark` stylesheet loaded once in src/components/markdown-body.tsx), so
 * a file quoted in a message and the same file opened from a command row look
 * alike (bw-4wcd.2).
 *
 * Nothing here decides anything about a language it does not know: a file with
 * no match is drawn plain, which is what it looked like before.
 */
import hljs from 'highlight.js/lib/common';

/** What a file's ending says its language is, for the languages hljs carries. */
const BY_ENDING: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  r: 'r',
  sql: 'sql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  md: 'markdown',
  markdown: 'markdown',
  patch: 'diff',
  diff: 'diff',
  graphql: 'graphql',
  gql: 'graphql',
};

/** Files with no ending whose name is the whole answer. */
const BY_NAME: Record<string, string> = {
  makefile: 'makefile',
  dockerfile: 'bash',
  gemfile: 'ruby',
  rakefile: 'ruby',
};

/**
 * The language a path implies, or null when nothing here knows it.
 *
 * A dotfile is its own ending — `.bashrc` is bash — and a path is taken apart
 * from its last segment, so a directory called `src.rs` cannot decide it.
 */
export function languageOf(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (!name) return null;
  const named = BY_NAME[name.replace(/\..*$/, '')];
  if (named && !name.includes('.')) return named;
  const ending = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name.replace(/^\./, '');
  const found = BY_ENDING[ending] ?? null;
  return found && hljs.getLanguage(found) ? found : null;
}

/**
 * One piece of text as coloured HTML, or null to draw it plain.
 *
 * `highlight.js` escapes what it does not colour, so the result is safe to put
 * into the page — which is the only reason this may be drawn as HTML at all.
 * A language it does not carry, or text it chokes on, comes back null rather
 * than half-painted.
 */
export function paint(text: string, language: string | null): string | null {
  if (!language || !text) return null;
  if (!hljs.getLanguage(language)) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/**
 * The language of a command row's arguments, and of what it printed.
 *
 * A shell command is shell whatever it touches; a file the agent read or wrote
 * is its own language, and what a command PRINTS is a terminal's output rather
 * than a language — only a read hands back the file itself.
 */
export function languagesOf(
  name: string,
  input: Record<string, unknown>,
): { asked: string | null; printed: string | null } {
  const path = typeof input.file_path === 'string' ? input.file_path : '';
  const ofFile = path ? languageOf(path) : null;
  if (name === 'Bash' || name === 'BashOutput') return { asked: 'bash', printed: null };
  if (name === 'Read' || name === 'NotebookRead') return { asked: null, printed: ofFile };
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit') return { asked: ofFile, printed: null };
  return { asked: null, printed: null };
}
