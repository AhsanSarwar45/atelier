'use client';

import { Suspense } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

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
  const params = useSearchParams();
  const router = useRouter();
  const projectId = params.get('id');
  const openChat = params.get('chat');
  // The address decides which tab is showing, so a link from a card, a tray row
  // or a live line on the board lands on the chat it names — a tab holding its
  // own state would stay where it was and quietly ignore the link.
  const tab = params.get('tab') === 'chat' || openChat ? 'chat' : 'board';
  const { project } = useProject(projectId);

  return (
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
      className="w-full"
    >
      <TabsList className="mx-4 mt-3" data-testid="project-tabs">
        <TabsTrigger value="chat" data-testid="tab-chat">
          Chat
        </TabsTrigger>
        <TabsTrigger value="board" data-testid="tab-board">
          Board
        </TabsTrigger>
      </TabsList>
      <TabsContent value="chat">
        <ChatTab projectId={projectId} projectPath={project?.path ?? null} openSessionId={openChat} />
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
