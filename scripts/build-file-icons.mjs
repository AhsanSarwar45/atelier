#!/usr/bin/env node
/**
 * The file tree's icons, taken from material-icon-theme and cut down to the
 * ones this app can actually meet (bw-g3o3.12).
 *
 * The theme ships 1,251 SVGs and about eight thousand rules for choosing
 * between them. Shipping all of that would be a megabyte of static assets and
 * a manifest bigger than the tree that reads it, for icons nobody here will
 * ever see — nothing in this codebase is written in ABAP. So this copies only
 * the SVGs the curated lists below name, and writes a manifest holding only
 * those rules.
 *
 * The SVGs land in `public/file-icons/` as plain static files, never as
 * components: the tree draws them with `<img src>`, so a hundred file types
 * cost the bundle nothing at all. `public/file-icons/` is generated and is not
 * kept in git; this runs on `postinstall`, so a fresh clone has it before the
 * first build.
 *
 * The written manifest IS kept in git, because it is read by the type checker
 * and by tests, and a repository whose types only exist after an install is one
 * where an editor shows red on a clean checkout.
 *
 * Adding an icon: put the extension, filename or folder name in a list below
 * and run `node scripts/build-file-icons.mjs`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THEME = join(ROOT, 'node_modules', 'material-icon-theme');
const OUT_SVG = join(ROOT, 'public', 'file-icons');
const OUT_TS = join(ROOT, 'src', 'components', 'file-icons.ts');

/**
 * The endings worth an icon of their own: the languages, the configuration
 * formats and the media a project here actually holds. A compound ending
 * (`d.ts`, `test.tsx`, `tar.gz`) is listed whole and matched longest-first, the
 * way the theme itself matches.
 */
const EXTENSIONS = [
  // TypeScript and JavaScript, and the shapes a test or a type file takes.
  'ts', 'tsx', 'mts', 'cts', 'd.ts', 'test.ts', 'test.tsx', 'spec.ts', 'spec.tsx',
  'js', 'jsx', 'mjs', 'cjs', 'test.js', 'spec.js', 'map',
  // The rest of the languages.
  'rs', 'py', 'pyi', 'go', 'rb', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp',
  'hpp', 'cs', 'php', 'lua', 'r', 'sql', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'pl', 'ex', 'exs', 'erl', 'hs', 'clj', 'scala', 'dart', 'zig', 'nim', 'vim',
  // Markup, styles and data.
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'json', 'jsonc', 'json5',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'xml', 'csv', 'tsv',
  'md', 'mdx', 'rst', 'txt', 'tex', 'graphql', 'proto', 'lock',
  // Pictures, media and the things that are not text at all.
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'pdf', 'zip', 'tar', 'gz',
  'tar.gz', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm', 'exe', 'so', 'dll',
  // Everything else that turns up in a checkout.
  'log', 'diff', 'patch', 'bak', 'tmp', 'sqlite', 'db', 'ipynb', 'nix', 'bicep',
];

/** Whole filenames that mean something more than their ending does. */
const NAMES = [
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml',
  '.dockerignore', '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep',
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'tsconfig.json', 'jsconfig.json', 'next.config.js', 'vite.config.ts',
  'vitest.config.ts', 'playwright.config.ts', 'tailwind.config.js',
  'postcss.config.js', 'eslint.config.js', '.eslintrc.json', '.prettierrc',
  '.editorconfig', '.npmrc', '.nvmrc', '.env', '.env.local',
  'cargo.toml', 'cargo.lock', 'rust-toolchain.toml', 'rustfmt.toml',
  'makefile', 'cmakelists.txt', 'justfile', 'procfile',
  'readme.md', 'license', 'licence', 'changelog.md', 'contributing.md',
  'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'setup.py',
  'gemfile', 'rakefile', '.bashrc', '.zshrc', 'claude.md', 'agents.md',
];

/** Folder names worth telling apart at a glance. */
const FOLDERS = [
  'src', 'lib', 'app', 'components', 'pages', 'public', 'assets', 'images',
  'styles', 'css', 'scripts', 'tests', 'test', '__tests__', 'docs', 'dist',
  'build', 'out', 'node_modules', 'config', 'server', 'client', 'api', 'hooks',
  'utils', 'tools', 'bin', 'examples', 'templates', 'themes', 'fonts', 'i18n',
  'database', 'migrations', 'models', 'views', 'controllers', 'routes',
  'middleware', 'plugins', 'packages', 'target', 'coverage', 'log', 'temp',
  '.git', '.github', '.vscode', 'android', 'ios', 'archive', 'audio', 'video',
];

// A production install (`--omit=dev`) has no theme to copy from. The tree
// draws lucide glyphs for anything it has no material icon for, so that build
// is plainer rather than broken, and saying so beats failing the install.
if (!existsSync(join(THEME, 'dist', 'material-icons.json'))) {
  console.log('file icons: material-icon-theme is not installed; the tree will use its lucide fallbacks');
  process.exit(0);
}

const theme = JSON.parse(readFileSync(join(THEME, 'dist', 'material-icons.json'), 'utf8'));

/** The SVG a definition names, as a bare icon name. */
function svgOf(icon) {
  const path = theme.iconDefinitions[icon]?.iconPath;
  if (!path) return null;
  const file = path.slice(path.lastIndexOf('/') + 1);
  return existsSync(join(THEME, 'icons', file)) ? file : null;
}

/** Every SVG that has to be copied, by filename. */
const wanted = new Set();

/** `key -> icon name`, keeping only the keys the theme really knows. */
function pick(keys, from) {
  const out = {};
  for (const key of keys) {
    const icon = from[key];
    if (!icon || !svgOf(icon)) continue;
    out[key] = icon;
    wanted.add(svgOf(icon));
  }
  return out;
}

const byExtension = pick(EXTENSIONS, theme.fileExtensions);
const byName = pick(NAMES, theme.fileNames);

/** A folder is two icons: shut and open. Both, or neither. */
const byFolder = {};
for (const name of FOLDERS) {
  const shut = theme.folderNames[name];
  const open = theme.folderNamesExpanded[name];
  if (!shut || !open || !svgOf(shut) || !svgOf(open)) continue;
  byFolder[name] = [shut, open];
  wanted.add(svgOf(shut));
  wanted.add(svgOf(open));
}

// The three the tree falls back to when nothing above matches. Without these a
// plain `.foo` file would have no icon at all, and the tree would be a column
// of gaps.
const FALLBACK = { file: theme.file, folder: theme.folder, folderOpen: theme.folderExpanded };
for (const icon of Object.values(FALLBACK)) wanted.add(svgOf(icon));

// Copied fresh every time, so an icon dropped from a list above stops being
// served rather than lingering from the install before it.
rmSync(OUT_SVG, { recursive: true, force: true });
mkdirSync(OUT_SVG, { recursive: true });
for (const file of [...wanted].sort()) {
  writeFileSync(join(OUT_SVG, file), readFileSync(join(THEME, 'icons', file)));
}

const spell = (record) => JSON.stringify(record, Object.keys(record).sort(), 2);

const manifest = `/**
 * Which icon a name gets, cut out of material-icon-theme (MIT).
 *
 * GENERATED by scripts/build-file-icons.mjs. Do not edit by hand: add the
 * extension, filename or folder name to a list in that script and run it.
 *
 * These are names, not pictures. The pictures are static SVGs under
 * \`public/file-icons/\`, drawn with \`<img>\`, so the whole set costs the
 * bundle nothing beyond the few kilobytes of this table. \`src/components/
 * file-icon.tsx\` is what turns a name here into something on screen, and what
 * falls back to a lucide glyph for everything not listed.
 */

/** The theme this came from, so a bump can be told from a hand edit. */
export const ICON_THEME_VERSION = ${JSON.stringify(JSON.parse(readFileSync(join(THEME, 'package.json'), 'utf8')).version)};

/** By file ending, lower-cased. Compound endings are matched longest-first. */
export const ICON_BY_EXTENSION: Record<string, string> = ${spell(byExtension)};

/** By whole filename, lower-cased. Beats the ending. */
export const ICON_BY_NAME: Record<string, string> = ${spell(byName)};

/** By folder name, lower-cased: shut first, then open. */
export const ICON_BY_FOLDER: Record<string, readonly [string, string]> = ${spell(byFolder)};

/** What anything unrecognised gets, when a material icon is wanted anyway. */
export const ICON_FALLBACK = ${JSON.stringify(FALLBACK, null, 2)} as const;

/** Where a name here is served from. */
export function iconUrl(icon: string): string {
  return \`/file-icons/\${icon}.svg\`;
}
`;

// Written only when it differs, so an install does not dirty a clean checkout.
if (!existsSync(OUT_TS) || readFileSync(OUT_TS, 'utf8') !== manifest) {
  writeFileSync(OUT_TS, manifest);
}

console.log(
  `file icons: ${readdirSync(OUT_SVG).length} SVGs, ` +
  `${Object.keys(byExtension).length} endings, ${Object.keys(byName).length} names, ` +
  `${Object.keys(byFolder).length} folders`,
);
