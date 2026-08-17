'use client';

import { Suspense, useCallback, useState } from 'react';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { ArrowLeft, EllipsisVertical } from 'lucide-react';

import { CardPanel } from '@/components/card-panel';
import { ProjectSettingsDialog } from '@/components/project-settings-dialog';
import { Shell } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProject } from '@/hooks/use-project';
import { useTheme } from '@/hooks/use-theme';
import { addressWith, whereFrom } from '@/lib/address';
import { cn } from '@/lib/utils';
import ChatTab from '@/workbench/chat-tab';
import { WorkbenchStatus } from '@/workbench/globals';

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
  const { project, refetch } = useProject(projectId);
  const { theme } = useTheme();
  const terminal = theme.headerVariant === 'terminal';
  const [settingsOpen, setSettingsOpen] = useState(false);

  /** A move he made by hand: it belongs in the history, so Back undoes it. */
  const go = useCallback(
    (patch: Parameters<typeof addressWith>[1]) => router.push(addressWith(params, patch)),
    [router, params],
  );

  // Opening a card is a push, so Back closes it. Closing it by hand rewrites the
  // address instead of adding to it, so Back still means "what I was looking at
  // before the card", never "open it again".
  const closeCard = useCallback(
    () => router.replace(addressWith(params, { card: null })),
    [router, params],
  );

  return (
    <Shell
      activeTab={tab}
      barClassName={terminal ? 'terminal-header' : undefined}
      bar={
        <>
          <Button variant="ghost" size="icon" asChild>
            {/* A link, not a fresh document: the list is a step back in the same
                app, so the history keeps what was open on this screen. */}
            <Link href="/">
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">Back to projects</span>
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
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Project settings"
            data-testid="project-menu"
            onClick={() => setSettingsOpen(true)}
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </Button>
          <WorkbenchStatus />
        </>
      }
      tabs={
        <Tabs
          value={tab}
          // Pushed, so the tab he left is a step back. It also keeps the chat it
          // was pointed at: coming back to Chat should be the conversation he
          // was reading, not an empty tab.
          onValueChange={(next) => go({ tab: next === 'chat' ? 'chat' : 'board' })}
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
      }
    >
      {tab === 'chat' && (
        <ChatTab projectId={projectId} projectPath={project?.path ?? null} openSessionId={openChat} />
      )}
      {/* Only the tab in front is mounted: a board kept alive behind the chat is
          paid for on every switch, both ways (docs/designs/app-shell.md §1.6). */}
      {tab === 'board' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <KanbanBoard />
        </div>
      )}

      {/* One card panel for the whole screen, over whichever tab is showing
          (docs/designs/app-shell.md §1.8). Mounted only while a card is open, so
          the chat tab pays nothing for the board's list until he opens one. */}
      {openCard && project && (
        <CardPanel
          cardId={openCard}
          projectId={projectId}
          projectPath={project.path}
          projectLocalPath={project.localPath}
          onClose={closeCard}
          onOpenCard={(id) => go({ card: id })}
        />
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
