'use client';

import { type MouseEvent, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { ArrowLeft, EllipsisVertical, Home } from 'lucide-react';

import { CardPanel } from '@/components/card-panel';
import { ProjectSettingsDialog } from '@/components/project-settings-dialog';
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
  somewhereBehind,
  whereFrom,
} from '@/lib/address';
import { PRODUCT_NAME } from '@/lib/identity';
import { cn, projectDir } from '@/lib/utils';
import ChatTab from '@/workbench/chat-tab';
import { WorkbenchStatus } from '@/workbench/globals';
import { useShowingFolder } from '@/workbench/terminal-shells';

import { BoardCards } from './board-cards';
import KanbanBoard from './kanban-board';

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
  const { id: projectId, tab, chat: openChat, card: openCard } = whereFrom(params);
  const { project, error: projectError, refetch } = useProject(projectId);
  // The folder this screen is showing, which is where a shell opened from
  // its bar starts. `projectDir` and not `project.path`, because a
  // Dolt-backed board's path is a database address and no folder at all.
  useShowingFolder(projectDir(project));
  const { theme } = useTheme();
  const terminal = theme.headerVariant === 'terminal';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const usesBeads = project?.usesBeads !== false;
  const shownTab = usesBeads ? tab : 'chat';
  const shownCard = usesBeads ? openCard : null;

  useEffect(() => {
    document.title = project?.name ? `${project.name} | ${PRODUCT_NAME}` : PRODUCT_NAME;
    return () => { document.title = PRODUCT_NAME; };
  }, [project?.name]);

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

  // The bar's arrow gives back whatever he was on last — the chat a report was
  // named in, the board he opened a report from — the same as the browser's own
  // arrow, rather than throwing away the whole visit for the project list. A
  // held key or a middle click is him asking for a second tab, so those are left
  // to the link underneath, as is a screen with nothing of ours behind it.
  const stepBack = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (!somewhereBehind()) return;
      e.preventDefault();
      router.back();
    },
    [router],
  );

  // However the panel went — his Back, its own close, a link — the count of
  // entries we added comes down when the card leaves the address, so it cannot
  // drift upwards over a long visit.
  const cardBefore = useRef(openCard);
  useEffect(() => {
    if (cardBefore.current && !openCard) cardWasClosed();
    cardBefore.current = openCard;
  }, [openCard]);

  return (
    <Shell
      activeTab={shownTab}
      barClassName={terminal ? 'terminal-header' : undefined}
      bar={
        <>
          {/* Ink and strength named from the app's own text scale: the quiet
              button style is written in the borrowed colour names, and three
              skins paint that the same colour as the bar itself, so the arrow
              disappeared on them. The picture also carries its own strength,
              because the button dims any picture inside it to 60%. */}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-t-tertiary hover:bg-surface-overlay hover:text-t-primary"
            asChild
          >
            {/* A link, not a fresh document: the list is a step back in the same
                app, so the history keeps what was open on this screen. Written
                as a link to the list and turned into a step back at the moment
                it is pressed, so it draws the same before and after the browser
                takes it over, a middle-click still opens the list in its own
                tab, and a screen with nothing of ours behind it still has a way
                out. */}
            <Link href="/" data-testid="back-arrow" onClick={stepBack}>
              <ArrowLeft className="h-4 w-4 opacity-100" />
              <span className="sr-only">Back</span>
            </Link>
          </Button>
          {/* The way out that is always the same one. The arrow beside it is
              where the reader came from, which is a different question and by
              now a different answer, so the project list has a control of its
              own rather than being whatever the history happens to hold
              (bw-430t). Nothing is intercepted here: it is the plain link it
              looks like, at any depth. */}
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-t-tertiary hover:bg-surface-overlay hover:text-t-primary"
            asChild
          >
            <Link href="/" data-testid="home-button">
              <Home className="h-4 w-4 opacity-100" />
              <span className="sr-only">All projects</span>
            </Link>
          </Button>
          <h1
            data-testid="project-name"
            className={cn(
              'truncate',
              // The neo-brutalist theme spells a project's name its own way; the
              // bar it sits in is the same bar.
              terminal ? 'font-mono text-lg font-bold uppercase tracking-wide' : 'text-lg font-semibold',
            )}
          >
            {project?.name ?? ''}
            {terminal ? '_' : ''}
          </h1>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-t-tertiary hover:bg-surface-overlay hover:text-t-primary"
            aria-label="Project settings"
            data-testid="project-menu"
            onClick={() => setSettingsOpen(true)}
          >
            <EllipsisVertical className="h-3.5 w-3.5 opacity-100" />
          </Button>
          <WorkbenchStatus />
        </>
      }
      tabs={usesBeads ? (
        <Tabs
          value={tab}
          // Pushed, so the tab he left is a step back. It also keeps the chat or
          // chat it was pointed at: coming back to a tab should be what he was
          // reading, not an empty one.
          onValueChange={(next) =>
            go({ tab: next === 'chat' ? 'chat' : 'board' })
          }
        >
          <TabsList data-testid="project-tabs">
            <TabsTrigger value="chat" data-testid="tab-chat">
              Chat
            </TabsTrigger>
            <TabsTrigger value="board" data-testid="tab-board">
              Board
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : undefined}
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
            what="This project could not be read."
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

      {project && (
        <ProjectSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          projectId={project.id}
          projectName={project.name}
          projectPath={project.path}
          projectLocalPath={project.localPath}
          onUpdated={refetch}
        />
      )}
    </Shell>
  );
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ProjectTabs />
    </Suspense>
  );
}
