'use client';

import Link from 'next/link';
import { ArrowLeft, FileCode2 } from 'lucide-react';

import { AgentFilesBrowser } from '@/components/agent-files-browser';
import { Button } from '@/components/ui/button';
import { useProjects } from '@/hooks/use-projects';

export default function AgentFilesPage() {
  const { projects } = useProjects();
  return <div className="flex h-dvh flex-col overflow-hidden bg-surface-base">
    <header className="flex h-14 shrink-0 items-center gap-3 px-4 sm:px-6">
      <Button asChild variant="ghost" mode="icon" size="sm"><Link href="/settings" aria-label="Back to settings"><ArrowLeft /></Link></Button>
      <FileCode2 className="size-5 text-t-muted" />
      <h1 className="text-base font-semibold text-t-primary">Agent files</h1>
    </header>
    <AgentFilesBrowser projects={projects.filter((project) => !project.archivedAt).map(({ id, name, localPath, path }) => ({ id, name, path: localPath || path }))} />
  </div>;
}
