/**
 * The old address of the agent files. They are a section of the settings
 * screen now; a link already pasted somewhere still lands on them.
 */
'use client';

import { useEffect } from 'react';

import { useRouter } from 'next/navigation';

export default function AgentFilesPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/settings?section=files');
  }, [router]);
  return null;
}
