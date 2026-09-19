/**
 * The files as a search source (bw-21a2.8).
 *
 * Every file in the checkout the Files tab shows that git does not ignore,
 * found by what it says and what it is called: `content:loader ext:rs
 * path:server -name:test`. Each file is listed once with the lines the words
 * were found on, and opening one of those lines opens the file at it,
 * highlighted. The box, the controls and the AI search are shared with every
 * search (src/search); this is the files' keys and how a file is drawn
 * (server/src/routes/fs/search.rs).
 */
'use client';

import { useEffect, useMemo, useState } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { addressWith } from '@/lib/address';
import * as api from '@/lib/api';
import { Heading, PLACE } from '@/search/parts';
import { Marked, Search } from '@/search/search';
import type { Choice, FilterSpec, Found, SearchSource, Segment } from '@/search/source';
import type { Grammar } from '@/search/syntax';
import { filesRootKey, rootsAmong, rootShown } from '@/workbench/files-tab';

export interface FileLine {
  line: number;
  segments: Segment[];
}

export interface FileMatch {
  path: string;
  abs: string;
  pathSegments: Segment[] | null;
  matches: number;
  lines: FileLine[];
}

/** A file an agent found; `at` is the line, when it said. */
export interface FoundFile extends Found {
  id: string;
  path: string;
  abs: string;
}

export const FILE_SCOPES: Choice[] = [
  { value: 'content', label: 'Contents' },
  { value: 'file', label: 'Paths' },
];

const KINDS: Choice[] = [
  { value: 'ts,tsx', label: 'TypeScript' },
  { value: 'rs', label: 'Rust' },
  { value: 'md', label: 'Markdown' },
  { value: 'json', label: 'JSON' },
  { value: 'css', label: 'CSS' },
];

export const FILE_GRAMMAR: Grammar = {
  keys: {
    content: 'content', text: 'content', code: 'content',
    file: 'file',
    in: 'in',
    path: 'path', dir: 'path', folder: 'path', under: 'path',
    name: 'name', filename: 'name',
    ext: 'ext', extension: 'ext',
  },
  offered: ['content', 'file', 'in', 'path', 'name', 'ext'],
  values: {
    in: FILE_SCOPES.map((s) => s.value),
    ext: ['ts', 'tsx', 'rs', 'md', 'json', 'css', 'py', 'go'],
  },
};

const FILTERS: FilterSpec[] = [{ key: 'ext', label: 'Type', choices: KINDS }];

const TIPS = [
  { example: 'path:src/', meaning: 'In a folder' },
  { example: 'name:main', meaning: 'File name' },
];

/** The checkout the Files tab shows: the one it remembers while it is still there, else the project. */
function useFilesRoot(projectId: string | null, projectPath: string): string | null {
  const [root, setRoot] = useState<string | null>(null);
  useEffect(() => {
    const stop = new AbortController();
    const remembered = localStorage.getItem(filesRootKey(projectId));
    const settle = (trees: Parameters<typeof rootsAmong>[0]) =>
      setRoot(rootShown(rootsAmong(trees, projectPath), remembered, projectPath));
    api.git
      .trees(projectPath, stop.signal)
      .then((answer) => settle(answer.trees))
      .catch(() => {
        if (!stop.signal.aborted) settle([]);
      });
    return () => stop.abort();
  }, [projectId, projectPath]);
  return root;
}

function PathText({ path, segments }: { path: string; segments: Segment[] | null }) {
  if (segments) return <Marked segments={segments} />;
  const cut = path.lastIndexOf('/') + 1;
  return (
    <>
      <span className="text-muted-foreground">{path.slice(0, cut)}</span>
      {path.slice(cut)}
    </>
  );
}

/** The files under `root`, as the shared search draws and opens them. */
export function useFileSearch(root: string): SearchSource<FileMatch, FoundFile> {
  const router = useRouter();
  const params = useSearchParams();

  return useMemo(() => {
    const go = (file: string, line: number | null) => router.push(addressWith(params, { tab: 'files', file, line }));
    return {
      words: {
        label: 'Search files',
        placeholder: 'Search files…',
        nothing: 'No files.',
        grammar: FILE_GRAMMAR,
        scopes: FILE_SCOPES,
        filters: FILTERS,
        tips: TIPS,
        sorts: [
          { value: 'relevance', label: 'Best' },
          { value: 'path', label: 'Path' },
        ],
        find: async (q, sort, cursor) => {
          const query = new URLSearchParams({ root, q, sort, cursor: String(cursor) });
          const answer = await api.request(`/api/fs/search?${query}`);
          if (!answer.ok) return { items: [], next: null };
          const page = (await answer.json()) as { files: FileMatch[]; next: number | null };
          return { items: page.files, next: page.next };
        },
        groups: (files) =>
          files.map((file) => ({
            key: file.path,
            testId: 'search-file',
            attrs: { 'data-path': file.path },
            head: {
              key: file.path,
              testId: 'search-file-open',
              open: () => go(file.abs, null),
              body: (
                <Heading
                  title={
                    <>
                      <span data-testid="search-file-path" className="min-w-0 break-all font-mono text-xs text-foreground sm:truncate">
                        <PathText path={file.path} segments={file.pathSegments} />
                      </span>
                      {!!file.matches && (
                        <span data-testid="search-file-matches" className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
                          {file.matches}
                        </span>
                      )}
                    </>
                  }
                />
              ),
            },
            places: file.lines.map((line) => ({
              key: `${file.path}:${line.line}`,
              testId: 'search-file-line',
              attrs: { 'data-path': file.path, 'data-line': String(line.line) },
              className: PLACE,
              open: () => go(file.abs, line.line),
              body: (
                <div className="flex min-w-0 gap-2">
                  <span className="w-8 shrink-0 text-right font-mono text-[11px] leading-5 text-muted-foreground">{line.line}</span>
                  <span className="min-w-0 break-all font-mono text-xs leading-5 text-foreground/90">
                    <Marked segments={line.segments} />
                  </span>
                </div>
              ),
            })),
          })),
      },
      ask: {
        label: 'Ask about files',
        placeholder: 'Ask about files…',
        nothing: 'No files.',
        url: '/api/fs/search/ask',
        body: { root },
        row: (file) => {
          const line = Number(file.at) > 0 ? Number(file.at) : null;
          return {
            key: file.path,
            testId: 'ai-search-file',
            attrs: { 'data-path': file.path },
            open: () => go(file.abs, line),
            body: (
              <Heading
                title={
                  <span className="min-w-0 break-all font-mono text-xs text-foreground sm:truncate">
                    <PathText path={file.path} segments={null} />
                  </span>
                }
                meta={line && <span className="font-mono">line {line}</span>}
              />
            ),
          };
        },
      },
    };
  }, [root, router, params]);
}

export function FileSearchPanel({ projectId, projectPath, onClose }: { projectId: string | null; projectPath: string; onClose: () => void }) {
  const root = useFilesRoot(projectId, projectPath);
  const source = useFileSearch(root ?? projectPath);
  // The checkout is known in a moment; searching the wrong one first would flash its files.
  if (!root) return null;
  return <Search source={source} onClose={onClose} />;
}
