'use client';

import dynamic from 'next/dynamic';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { EllipsisVertical, Folder, Home, MessageSquare, SquareKanban } from 'lucide-react';

import { BackLink } from '@/components/back-link';
import { ProjectSwitcher } from '@/components/project-switcher';
import { ModalLayer } from '@/components/modal-layer';
// Only drawn once a card is opened, and it brings the markdown and code
// highlighter with it, so the board draws without them (bw-fbzd.7).
const CardPanel = dynamic(() => import('@/components/card-panel').then((m) => m.CardPanel), { ssr: false });
const ProjectSettingsScreen = dynamic(() => import('@/components/project-settings-screen').then((m) => m.ProjectSettingsScreen), { ssr: false });
import { Shell } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { ReadFailed } from '@/components/ui/read-failed';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProject } from '@/hooks/use-project';
import { useTheme } from '@/hooks/use-theme';
import {
  addressWith,
  cardCameFromHere,
  cardWasClosed,
  cardWasPushed,
  stepsOut,
  whereFrom,
} from '@/lib/address';
import { cn, projectDir } from '@/lib/utils';
import { SearchOpener } from '@/search/opener';
// Each tab's code is fetched when that tab is first shown, so a board does not
// wait on the chat's editor and transcript or the files view (bw-fbzd.4).
// The chat is fetched ahead once the screen is idle, so switching to it is
// still instant.
const loadChatTab = () => import('@/workbench/chat-tab');
/** How long a screen is left to its own reads before the chat is fetched ahead. */
const PRELOAD_AFTER_MS = 4_000;
const ChatTab = dynamic(loadChatTab, { ssr: false });
const FilesTab = dynamic(() => import('@/workbench/files-tab'), { ssr: false });
const SearchPanel = dynamic(() => import('@/workbench/search-panel').then((m) => m.SearchPanel), { ssr: false });
const BoardSearchPanel = dynamic(() => import('./board-search').then((m) => m.BoardSearchPanel), { ssr: false });
const FileSearchPanel = dynamic(() => import('@/workbench/file-search').then((m) => m.FileSearchPanel), { ssr: false });
import { WorkbenchStatus } from '@/workbench/globals';
import { PathsOpenProvider } from '@/workbench/open-path';
import { useShowingFolder } from '@/workbench/terminal-shells';

import { BoardCards } from './board-cards';
import KanbanBoard from './kanban-board';

/**
 * The three project tabs on a phone.
 *
 * The tab bar is shared: after Chat, Board and Files come whatever tools the
 * open tab hands it, and the board alone hands it eleven. At 390px the three
 * words were the first thing to spend that row and the tools were what got
 * pushed off it, so below `sm` each tab is its icon alone — the word is still
 * there for a screen reader, as `aria-label` on the tab itself.
 *
 * `min-w-11` is the 44px floor for a target a thumb has to hit: an icon in the
 * shared `px-3` comes to 40px on its own, which is under it. Above `sm` the
 * floor is dropped again so the tabs are sized by their words, exactly as they
 * always were.
 */
const TAB = 'gap-2 min-w-11 sm:min-w-0';
const GLYPH = 'size-4 shrink-0 sm:hidden';
const WORD = 'hidden sm:inline';

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );
}

function ProjectTabs() {
  const params = useSearchParams();
  const router = useRouter();
  // The address decides which tab is showing, which chat is drawn in it and
  // which card is over the top, so every one of them survives a link, a fresh
  // tab and the Back button (docs/designs/app-shell.md §1.7).
  const { id: projectId, tab, chat: openChat, card: openCard, file: openFile, line: openLine, settings: openSettings, ptab } = whereFrom(params);
  const { project, error: projectError, refetch } = useProject(projectId);
  // The folder this screen is showing, which is where a shell opened from
  // its bar starts. `projectDir` and not `project.path`, because a
  // Dolt-backed board's path is a database address and no folder at all.
  useShowingFolder(projectDir(project));
  const { theme } = useTheme();
  const terminal = theme.headerVariant === 'terminal';
  const usesBeads = project?.usesBeads !== false;
  // The board is the one tab a project can opt out of. Files are files whether
  // or not anybody keeps cards here, so opting out of the board sends the board
  // back to the chat and leaves the other two alone.
  const shownTab = usesBeads || tab !== 'board' ? tab : 'chat';
  const shownCard = usesBeads ? openCard : null;

  // The chat is its own download so the board draws without it; once the
  // screen has nothing else to do it is fetched ahead, and switching to it
  // does not wait on the network. Idle alone came 70 ms into the load, while
  // the board was still downloading, and a device on the network fetched
  // 300 KiB of chat beside it; so it waits until the page's own reads are
  // well past (bw-fbzd.9).
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((ahead: () => void) => window.setTimeout(ahead, 0));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    let ask: number | undefined;
    const later = window.setTimeout(() => { ask = idle(() => { void loadChatTab(); }); }, PRELOAD_AFTER_MS);
    return () => {
      window.clearTimeout(later);
      if (ask !== undefined) cancel(ask);
    };
  }, []);

  // Old bookmarks can still name the board for a project that has since opted
  // out. Draw chat immediately, then clean the address so refresh and Back do
  // not lead back into a board read that can never succeed.
  useEffect(() => {
    if (project?.usesBeads === false && (tab === 'board' || openCard)) {
      router.replace(addressWith(params, { tab: 'chat', card: null }));
    }
  }, [project?.usesBeads, tab, openCard, router, params]);

  /** A move he made by hand: it belongs in the history, so Back undoes it. */
  const go = useCallback(
    (patch: Parameters<typeof addressWith>[1]) => router.push(addressWith(params, patch)),
    [router, params],
  );

  // Opening a card pushes, so Back closes it; closing it by hand steps back off
  // that same entry. Rewriting the address instead would leave a Back press that
  // goes nowhere, one per card he looked at (bw-m8o.10). A card he ARRIVED on —
  // a pasted link — has nothing of ours behind it, so that one is rewritten.
  const closeCard = useCallback(() => {
    if (cardCameFromHere()) {
      router.back();
      return;
    }
    router.replace(addressWith(params, { card: null }));
  }, [router, params]);

  // However the panel went — his Back, its own close, a link — the count of
  // entries we added comes down when the card leaves the address, so it cannot
  // drift upwards over a long visit.
  const cardBefore = useRef(openCard);

  // The settings are pushed one entry per section and tab, so the arrow that
  // closes them has to step over every entry this visit added; a pasted
  // address added none and is simply left for the project (bw-2t1c.10).
  const settingsPushes = useRef(0);
  useEffect(() => {
    if (!openSettings) settingsPushes.current = 0;
  }, [openSettings]);
  const goSettings = useCallback(
    (patch: Parameters<typeof addressWith>[1]) => {
      settingsPushes.current += 1;
      go(patch);
    },
    [go],
  );
  useEffect(() => {
    if (cardBefore.current && !openCard) cardWasClosed();
    cardBefore.current = openCard;
  }, [openCard]);

  // Ctrl+K, or Cmd+K, opens the showing tab's search from anywhere on the
  // screen — but a terminal keeps the keys its shell is owed. A tab's own
  // controls open the same search (src/search/opener.tsx).
  const [searching, setSearching] = useState(false);
  const openSearch = useCallback(() => setSearching(true), []);
  const closeSearch = useCallback(() => setSearching(false), []);
  useEffect(() => {
    const pressed = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('.xterm')) return;
      event.preventDefault();
      setSearching((was) => !was);
    };
    window.addEventListener('keydown', pressed);
    return () => window.removeEventListener('keydown', pressed);
  }, []);

  const screen = (
    <Shell
      activeTab={shownTab}
      // The chat's own controls sit in this bar, so it is drawn whether or not
      // the project has a board to put tabs in.
      toolbar
      barClassName={terminal ? 'terminal-header' : undefined}
      bar={
        <>
          {/* Two pictures side by side, so they are spaced as a pair rather
              than at the bar's own stride: the bar leaves room for a control
              to meet a WORD, and between two icons that room lands on top of
              the padding each of them already carries. Four pixels here and
              six either side of the name below put the same twenty-four
              between every neighbour in the row (bw-r8dg.1). */}
          <div className="flex shrink-0 items-center gap-1">
            <BackLink href="/" />
            {/* The way out that is always the same one. The arrow beside it is
                where the reader came from, which is a different question and by
                now a different answer, so the project list has a control of its
                own rather than being whatever the history happens to hold
                (bw-430t). Nothing is intercepted here: it is the plain link it
                looks like, at any depth. */}
            <Button
              variant="ghost"
              size="icon"
              data-reach="band"
              className="shrink-0 text-t-tertiary hover:bg-surface-overlay hover:text-t-primary"
              asChild
            >
              <Link href="/" data-testid="home-button">
                <Home className="h-4 w-4 opacity-100" />
                <span className="sr-only">All projects</span>
              </Link>
            </Button>
          </div>
          {/* The name is also the way to another project (bw-r8dg.2), and
              still the heading this screen is named by, with the control
              inside it. Six
              pixels either side on top of the bar's own eight: the name is a
              word and its neighbours are pictures carrying ten pixels of
              padding apiece, so this is what makes the gap beside it the same
              as the gap between two of them (bw-r8dg.1). */}
          <h1 className="mx-1.5 min-w-0">
            <ProjectSwitcher
              projectId={projectId}
              name={`${project?.name ?? ''}${terminal ? '_' : ''}`}
              // The neo-brutalist theme spells a project's name its own way;
              // the bar it sits in is the same bar.
              nameClassName={
                terminal
                  ? 'font-mono text-lg font-bold uppercase tracking-wide'
                  : 'text-lg font-semibold'
              }
            />
          </h1>
          <Button
            variant="ghost"
            size="icon"
            data-reach="band"
            // The same box as the arrow and the house. It used to be drawn
            // smaller than both, which gave it less padding than them and so a
            // different gap on either side of it (bw-r8dg.1).
            className="shrink-0 text-t-tertiary hover:bg-surface-overlay hover:text-t-primary"
            aria-label="Project settings"
            data-testid="project-menu"
            onClick={() => goSettings({ settings: 'project', ptab: null })}
          >
            <EllipsisVertical className="h-4 w-4 opacity-100" />
          </Button>
          <WorkbenchStatus />
        </>
      }
      tabs={
        <Tabs
          value={shownTab}
          // Pushed, so the tab he left is a step back. It also keeps the chat or
          // chat it was pointed at: coming back to a tab should be what he was
          // reading, not an empty one.
          onValueChange={(next) =>
            go({ tab: next === 'chat' ? 'chat' : next === 'files' ? 'files' : 'board' })
          }
        >
          <TabsList data-testid="project-tabs">
            <TabsTrigger value="chat" data-testid="tab-chat" aria-label="Chat" className={TAB}>
              <MessageSquare className={GLYPH} aria-hidden="true" />
              <span className={WORD}>Chat</span>
            </TabsTrigger>
            {/* Only the board needs a board. Files stand on the folder itself,
                so a project that keeps no cards still gets them. */}
            {usesBeads && (
              <TabsTrigger value="board" data-testid="tab-board" aria-label="Board" className={TAB}>
                <SquareKanban className={GLYPH} aria-hidden="true" />
                <span className={WORD}>Board</span>
              </TabsTrigger>
            )}
            <TabsTrigger value="files" data-testid="tab-files" aria-label="Files" className={TAB}>
              <Folder className={GLYPH} aria-hidden="true" />
              <span className={WORD}>Files</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      }
    >
      {/* The project itself could not be read, so nothing under the tabs has
          anything to draw: every one of them is mounted only once the project
          is in hand. Without this the body was simply empty — the tabs sitting
          over nothing, with no word about why and no way to ask again, which is
          the same dead end as a spinner that never stops (bw-zkh4). */}
      {projectError && !project && (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <ReadFailed
            data-testid="project-error"
            what="Couldn’t load project."
            why={projectError.message}
            onRetry={() => void refetch()}
          >
            <Button variant="ghost" size="sm" asChild>
              <Link href="/">All projects</Link>
            </Button>
          </ReadFailed>
        </div>
      )}

      {shownTab === 'chat' && !projectError && (
        <ChatTab projectId={projectId} projectPath={project?.path ?? null} openSessionId={openChat} />
      )}

      {/* Only the tab in front is mounted here too: a tree left alive behind the
          chat keeps watching a folder nobody is looking at. */}
      {shownTab === 'files' && !projectError && (
        <FilesTab
          projectId={projectId}
          projectPath={project?.path ?? null}
          file={openFile}
          line={openLine}
        />
      )}

      {/* The board and card panel read ONE list, held here: an edit in the panel
          moves the card behind it. It is
          mounted only when one of them is on screen, so the chat tab alone
          still pays nothing for the board (docs/designs/app-shell.md §1.6). */}
      {usesBeads && (shownTab === 'board' || shownCard) && project && (
        <BoardCards projectPath={project.path}>
          {/* Only the tab in front is mounted: a board kept alive behind the
              chat is paid for on every switch, both ways. */}
          {shownTab === 'board' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <KanbanBoard />
            </div>
          )}
          {/* One card panel for the whole screen, over whichever tab is showing
              (docs/designs/app-shell.md §1.8). */}
          {shownCard && (
            <CardPanel
              cardId={shownCard}
              projectId={projectId}
              projectPath={project.path}
              projectLocalPath={project.localPath}
              onClose={closeCard}
              onOpenCard={(id) => {
                cardWasPushed();
                go({ card: id });
              }}
            />
          )}
        </BoardCards>
      )}

      {project && openSettings && (
        <ModalLayer label={`${project.name} settings`} data-testid="project-settings">
          <ProjectSettingsScreen
            projectId={project.id}
            projectName={project.name}
            projectPath={project.path}
            projectLocalPath={project.localPath}
            archivedAt={project.archivedAt ?? undefined}
            section={openSettings === 'list' ? null : openSettings}
            tab={ptab}
            onOpen={(id) => goSettings({ settings: id ?? 'list', ptab: null })}
            onTab={(id) => goSettings({ ptab: id })}
            backHref={addressWith(params, { settings: null, ptab: null })}
            backSteps={() => stepsOut((url) => !url.searchParams.has('settings'), settingsPushes.current)}
            onUpdated={refetch}
          />
        </ModalLayer>
      )}
    </Shell>
  );

  // Every file path anywhere under here has to know whether it lives in this
  // project or one of its worktrees, because that is what decides whether it
  // opens in the Files tab or leaves for the desktop (bw-g3o3.9). It is read
  // once, here, rather than by each of the hundreds of chips that ask.
  return (
    <SearchOpener value={openSearch}>
      <PathsOpenProvider projectPath={projectDir(project)}>
        {screen}
        {searching &&
          (shownTab === 'board' && project ? (
            <BoardSearchPanel projectPath={project.path} onClose={closeSearch} />
          ) : shownTab === 'files' && project ? (
            <FileSearchPanel projectId={projectId} projectPath={project.path} onClose={closeSearch} />
          ) : (
            <SearchPanel onClose={closeSearch} />
          ))}
      </PathsOpenProvider>
    </SearchOpener>
  );
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ProjectTabs />
    </Suspense>
  );
}
