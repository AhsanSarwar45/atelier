/** The Tags section: the labels a project can carry, kept on the server. */
'use client';

import { useEffect, useState } from 'react';

import { Trash2 } from 'lucide-react';

import { ColorPicker } from '@/components/color-picker';
import { SettingsGroup } from '@/components/settings/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { Tooltip } from '@/components/ui/tooltip';
import { createTag, deleteTag, getTags, type Tag } from '@/lib/db';

const NEW_COLOR = '#3b82f6';

export function TagsSettings() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(NEW_COLOR);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    getTags()
      .then((loaded) => live && setTags(loaded))
      .catch((e: unknown) => {
        // Told to the reader, not only to a console he will never open.
        if (live) {
          setTags([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [attempt]);

  const reset = () => {
    setAdding(false);
    setName('');
    setColor(NEW_COLOR);
  };

  const create = async () => {
    if (!name.trim()) return;
    try {
      const tag = await createTag({ name: name.trim(), color });
      setTags((prev) => [...prev, tag]);
      reset();
    } catch (e) {
      console.error('Failed to create tag:', e);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteTag(id);
      setTags((prev) => prev.filter((t) => t.id !== id));
    } catch (e) {
      console.error('Failed to delete tag:', e);
    }
  };

  return (
    <SettingsGroup
      title="Tags"
      actions={
        !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add tag
          </Button>
        )
      }
    >
      {loading ? (
        <p className="p-3 text-sm text-t-tertiary">Loading tags…</p>
      ) : error ? (
        <div className="p-3">
          <ReadFailed
            data-testid="tags-error"
            what="Your tags could not be read."
            why={error}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </div>
      ) : tags.length === 0 && !adding ? (
        <p className="p-3 text-sm text-t-tertiary">No tags yet.</p>
      ) : (
        tags.map((tag) => (
          <div key={tag.id} className="flex items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="size-4 rounded-full" style={{ backgroundColor: tag.color }} aria-hidden="true" />
              <span className="text-sm font-medium text-t-secondary">{tag.name}</span>
            </div>
            <Tooltip label="Delete tag">
              <Button
                variant="ghost"
                mode="icon"
                size="sm"
                onClick={() => remove(tag.id)}
                aria-label={`Delete tag ${tag.name}`}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            </Tooltip>
          </div>
        ))
      )}
      {adding && (
        <div className="space-y-3 p-3">
          <div className="flex items-center gap-2">
            <ColorPicker value={color} onChange={setColor} />
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tag name…"
              aria-label="Tag name"
              className="flex-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') create();
                else if (e.key === 'Escape') reset();
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={reset}>
              Cancel
            </Button>
            <Button size="sm" onClick={create} disabled={!name.trim()}>
              Create tag
            </Button>
          </div>
        </div>
      )}
    </SettingsGroup>
  );
}
