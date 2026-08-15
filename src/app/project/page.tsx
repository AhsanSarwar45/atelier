'use client';

import { Suspense } from 'react';

import { useSearchParams } from 'next/navigation';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useProject } from '@/hooks/use-project';
import ChatTab from '@/workbench/chat-tab';

import KanbanBoard from './kanban-board';

function LoadingFallback() {
  return (
    <div className="flex items-center justify-center h-screen">
      <div className="text-muted-foreground">Loading...</div>
    </div>
  );
}

function ProjectTabs() {
  const projectId = useSearchParams().get('id');
  const { project } = useProject(projectId);

  return (
    <Tabs defaultValue="board" className="w-full">
      <TabsList className="mx-4 mt-3" data-testid="project-tabs">
        <TabsTrigger value="chat" data-testid="tab-chat">
          Chat
        </TabsTrigger>
        <TabsTrigger value="board" data-testid="tab-board">
          Board
        </TabsTrigger>
      </TabsList>
      <TabsContent value="chat">
        <ChatTab projectId={projectId} projectPath={project?.path ?? null} />
      </TabsContent>
      {/* forceMount keeps the board mounted across tab switches, so its beads
          are not refetched every time the owner looks at the chat. */}
      <TabsContent value="board" forceMount className="data-[state=inactive]:hidden">
        <KanbanBoard />
      </TabsContent>
    </Tabs>
  );
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<LoadingFallback />}>
      <ProjectTabs />
    </Suspense>
  );
}
