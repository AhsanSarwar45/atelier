'use client';

/**
 * Whether the owner's Use tasks switch is on for a project (or the app):
 * where it is off, the project shows no Tasks tab, no task waiting bar and
 * no task lines in the `@` menu (docs/tasks.md, "Turning tasks off").
 *
 * On until the server says otherwise, so the usual case never flickers.
 */
import { useEffect, useState } from 'react';

import { tasks as tasksApi } from '@/lib/api';
import { onWorkbench } from '@/workbench/live-wire';

export function useTasksOn(projectId?: string | null): boolean {
  const [on, setOn] = useState(true);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let gone = false;
    tasksApi.switchState(projectId)
      .then((read) => { if (!gone) setOn(read.enabled); })
      .catch(() => {});
    return () => { gone = true; };
  }, [projectId, round]);
  useEffect(
    () => onWorkbench({ frame: (data) => { if (data.includes('tasksSwitch.changed')) setRound((n) => n + 1); }, dropped: () => {} }),
    [],
  );
  return on;
}
