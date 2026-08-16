'use client';

import { Suspense, useState } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { ArrowLeft, EllipsisVertical } from 'lucide-react';

import { ProjectSettingsDialog } from '@/components/project-settings-dialog';
import { Shell } from '@/components/shell';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProject } from '@/hooks/use-project';
import { useTheme } from '@/hooks/use-theme';
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
  const projectId = params.get('id');
  const openChat = params.get('chat');
  // The address decides which tab is showing, so a link from a card, a tray row
  // or a live line on the board lands on the chat it names — a tab holding its
  // own state would stay where it was and quietly ignore the link.
  const tab = params.get('tab') === 'chat' || openChat ? 'chat' : 'board';
  const { project, refetch } = useProject(projectId);
  const { theme } = useTheme();
  const terminal = theme.headerVariant === 'terminal';
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <Shell
      activeTab={tab}
      barClassName={terminal ? 'terminal-header' : undefined}
      bar={
        <>
          <Button variant="ghost" size="icon" asChild>
            <a href="/">
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">Back to projects</span>
            </a>
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
          onValueChange={(next) => {
            const q = new URLSearchParams(params.toString());
            q.set('tab', next);
            // The chat it was pointed at is not the tab's business once the owner
            // has moved off it by hand.
            if (next !== 'chat') q.delete('chat');
            router.replace(`/project?${q}`);
          }}
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
