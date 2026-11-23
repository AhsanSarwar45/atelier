'use client';

/**
 * The owner's tasks settings (docs/tasks.md, "Turning tasks off" and
 * "Require approval"): Use tasks and Require approval, each on or off for
 * the whole app, and for a project either the app's choice or its own.
 * Where tasks are off, chats are told nothing of tasks or grids; where
 * approval is off, agents create the tasks they need without asking.
 */
import { useEffect, useState } from 'react';

import { SettingRow, SettingsGroup } from '@/components/settings/section';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { tasks as tasksApi, type TasksSetting, type TasksSettingName, type TasksSwitchState } from '@/lib/api';
import { failure } from '@/workbench/grids/cell-detail';

const SETTINGS: Array<{ name: TasksSettingName; label: string; id: string; description: string }> = [
  {
    name: 'enabled',
    label: 'Use tasks',
    id: 'use-tasks',
    description: 'Tasks, proposals and coverage grids. When off, chats are not told about them and the Tasks tab is hidden. Open chats pick this up when they reconnect.',
  },
  {
    name: 'approval',
    label: 'Require approval',
    id: 'require-approval',
    description: 'Agents ask you before they create a task. When off, they create and start the tasks they need. Open chats pick this up when they reconnect.',
  },
];

const pick = (state: TasksSwitchState | null, name: TasksSettingName): TasksSetting | null =>
  state && (name === 'approval' ? state.approval : state);

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

  const set = async (name: TasksSettingName, enabled: boolean | null) => {
    setRefused(null);
    try {
      setState(await tasksApi.setSwitch(projectId, enabled, name));
    } catch (e) {
      setRefused(failure(e));
    }
  };

  return (
    <SettingsGroup data-testid="tasks-switch">
      {SETTINGS.map(({ name, label, id, description }) => {
        const setting = pick(state, name);
        if (!projectId) {
          return (
            <SettingRow key={name} label={label} description={description} htmlFor={id}>
              <Switch
                id={id}
                aria-label={label}
                checked={setting?.install ?? true}
                disabled={!state}
                onCheckedChange={(on) => void set(name, on)}
              />
            </SettingRow>
          );
        }
        const picked = setting ? (setting.project === null ? 'app' : setting.project ? 'on' : 'off') : 'app';
        return (
          <SettingRow key={name} label={label} description={description} htmlFor={id}>
            <Select
              value={picked}
              disabled={!state}
              onValueChange={(value) => void set(name, value === 'app' ? null : value === 'on')}
            >
              <SelectTrigger id={id} aria-label={label} className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="app">Same as app ({setting?.install === false ? 'Off' : 'On'})</SelectItem>
                <SelectItem value="on">On</SelectItem>
                <SelectItem value="off">Off</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
        );
      })}
      {refused && <p className="px-3 pb-3 text-xs text-destructive" role="alert">{refused}</p>}
    </SettingsGroup>
  );
}
