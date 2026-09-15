'use client';

import { Suspense, useEffect } from 'react';

import { useSearchParams } from 'next/navigation';

import { useProject } from '@/hooks/use-project';
import { projectTitle } from '@/lib/project-title';

/** The persistent project segment owns the title while child screens change. */
function ProjectTitle() {
  const params = useSearchParams();
  const projectId = params.get('id');
  const address = params.toString();
  const { project } = useProject(projectId);

  useEffect(() => {
    document.title = projectTitle(projectId, project?.name);
  }, [address, projectId, project?.name]);

  return null;
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}><ProjectTitle /></Suspense>
      {children}
    </>
  );
}
