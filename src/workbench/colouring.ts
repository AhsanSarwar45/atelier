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

/** Files whose name is the answer, whether or not an ending follows it. */
const BY_NAME: Record<string, string> = {
  makefile: 'makefile',
  dockerfile: 'bash',
  gemfile: 'ruby',
  rakefile: 'ruby',
  // A dotfile keeps its type in the name the dot hides, so these are read as
  // names rather than endings: `.bashrc` is bash, `.babelrc` is JSON.
  bashrc: 'bash',
  bash_aliases: 'bash',
  bash_profile: 'bash',
  profile: 'bash',
  zshenv: 'bash',
  zprofile: 'bash',
  zshrc: 'bash',
  editorconfig: 'ini',
  gitconfig: 'ini',
  npmrc: 'ini',
  babelrc: 'json',
  eslintrc: 'json',
  prettierrc: 'json',
};

/**
 * The language a path implies, or null when nothing here knows it.
 *
 * A path is taken apart from its last segment, so a directory called `src.rs`
 * cannot decide it. The leading dot of a dotfile marks the file hidden and says
 * nothing about what is in it, so it is dropped before anything is asked:
 * `.bashrc` is read as the name `bashrc`. The ending is asked first and the
 * name second, which is what lets `Dockerfile.dev` still be a Dockerfile while
 * `.eslintrc.json` is plain JSON. The earlier reading demanded a name carry no
 * dot at all, which every dotfile fails by definition, so `.bashrc`, `.npmrc`
 * and their like drew grey while the code claimed otherwise (bw-4wcd.17).
 */
export function languageOf(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  const bare = name.replace(/^\.+/, '');
  if (!bare) return null;
  const dot = bare.lastIndexOf('.');
  const ending = dot >= 0 ? bare.slice(dot + 1) : bare;
  const head = dot >= 0 ? bare.slice(0, bare.indexOf('.')) : bare;
  const found = BY_ENDING[ending] ?? BY_NAME[head] ?? null;
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
 * The same text, coloured whole, then handed back a line at a time.
 *
 * A line of code is not a language on its own: a block comment, a docstring or
 * a template string opens on one line and closes several lines later, and a
 * line lifted out of the middle of one reads as ordinary code. Painting each
 * line by itself did exactly that — the inside of every long comment came back
 * picked apart for keywords instead of staying comment-coloured, which is worse
 * than the grey it replaced (bw-4wcd.16).
 *
 * So the whole text is painted once, with the colourer carrying its state
 * across the newlines as it should, and only then cut: at each newline every
 * tag still open is closed, and the next line starts by opening the same ones
 * again. Every line therefore stands alone as HTML and can go in its own cell.
 * Null when the text would be drawn plain, and always one entry per line.
 */
export function paintLines(text: string, language: string | null): string[] | null {
  const html = paint(text, language);
  if (html === null) return null;
  // Only two things appear in what the colourer returns: its own spans, and
  // text with `&`, `<` and `>` already escaped. Everything else is content.
  const marks = /<span[^>]*>|<\/span>|\n/g;
  const lines: string[] = [];
  const open: string[] = [];
  let line = '';
  let last = 0;
  for (let m = marks.exec(html); m !== null; m = marks.exec(html)) {
    line += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0] === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else if (m[0] === '</span>') {
      open.pop();
      line += m[0];
    } else {
      open.push(m[0]);
      line += m[0];
    }
  }
  lines.push(line + html.slice(last) + '</span>'.repeat(open.length));
  return lines;
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
