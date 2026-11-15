'use client';

/**
 * The owner's Use tasks switch (docs/tasks.md, "Turning tasks off"): on or
 * off for the whole app, and for a project either the app's choice or its
 * own. Where tasks are off, chats are told nothing of tasks or grids.
 */
import { useEffect, useState } from 'react';

import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { RadioGroup, RadioGroupOption } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { tasks as tasksApi, type TasksSwitchState } from '@/lib/api';
import { failure } from '@/workbench/grids/cell-detail';

const MEANS = 'Tasks, proposals and coverage grids. When off, chats are not told about them and the Tasks tab is hidden. Open chats pick this up when they reconnect.';

export function TasksSwitch({ projectId }: { projectId?: string | null }) {
  const [state, setState] = useState<TasksSwitchState | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    tasksApi.switchState(projectId)
      .then((read) => { if (!gone) setState(read); })
      .catch((e) => { if (!gone) setRefused(failure(e)); });
    return () => { gone = true; };
  }, [projectId]);

  const set = async (enabled: boolean | null) => {
    setRefused(null);
    try {
      setState(await tasksApi.setSwitch(projectId, enabled));
    } catch (e) {
      setRefused(failure(e));
    }
  };

  const error = refused && <p className="px-3 pb-3 text-xs text-destructive" role="alert">{refused}</p>;

  if (!projectId) {
    return (
      <SettingsGroup data-testid="tasks-switch">
        <SettingRow label="Use tasks" description={MEANS} htmlFor="use-tasks">
          <Switch
            id="use-tasks"
            aria-label="Use tasks"
            checked={state?.install ?? true}
            disabled={!state}
            onCheckedChange={(on) => void set(on)}
          />
        </SettingRow>
        {error}
      </SettingsGroup>
    );
  }

  const picked = state ? (state.project === null ? 'app' : state.project ? 'on' : 'off') : 'app';
  return (
    <SettingsGroup data-testid="tasks-switch">
      <SettingRow label="Use tasks" description={MEANS} stack>
        <RadioGroup
          className="w-full"
          aria-label="Use tasks"
          value={picked}
          disabled={!state}
          onValueChange={(value) => void set(value === 'app' ? null : value === 'on')}
        >
          <RadioGroupOption value="app">Same as app ({state?.install === false ? 'Off' : 'On'})</RadioGroupOption>
          <RadioGroupOption value="on">On</RadioGroupOption>
          <RadioGroupOption value="off">Off</RadioGroupOption>
        </RadioGroup>
      </SettingRow>
      {error}
    </SettingsGroup>
  );
}
