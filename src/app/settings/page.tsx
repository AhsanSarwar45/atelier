"use client";

import { useState, useEffect } from "react";

import { ArrowLeft, ExternalLink, FileCode2, Trash2 } from "lucide-react";

import { ColorPicker } from "@/components/color-picker";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { ReadFailed } from "@/components/ui/read-failed";
import { Slider } from "@/components/ui/slider";
import { getTags, createTag, deleteTag, type Tag } from "@/lib/db";
import {
  applyFontSize,
  clampFontSize,
  DEFAULT_FONT_SIZE,
  FONT_SIZE_STORAGE_KEY,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
} from "@/lib/font-size";
import { TerminalSettings } from "@/workbench/terminal-settings";
import { DependenciesSettings } from "@/workbench/dependencies-settings";

export default function SettingsPage() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState("#3b82f6");
  const [isLoading, setIsLoading] = useState(true);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);

  useEffect(() => {
    async function loadTags() {
      setIsLoading(true);
      setTagsError(null);
      try {
        const loadedTags = await getTags();
        setTags(loadedTags);
      } catch (error) {
        // Told to the reader, not only to a console he will never open: a read
        // that failed here used to leave the screen saying he had no tags.
        console.error("Failed to load tags:", error);
        setTags([]);
        setTagsError(error instanceof Error ? error.message : String(error));
      }
      setIsLoading(false);
    }
    loadTags();
  }, [attempt]);

  useEffect(() => {
    const stored = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    const parsed = stored ? Number(stored) : DEFAULT_FONT_SIZE;
    const nextFontSize = clampFontSize(parsed);
    setFontSize(nextFontSize);
    applyFontSize(nextFontSize);
  }, []);

  const handleFontSizeChange = (value: number) => {
    const nextFontSize = clampFontSize(value);
    setFontSize(nextFontSize);
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(nextFontSize));
    applyFontSize(nextFontSize);
  };

  const handleResetFontSize = () => {
    setFontSize(DEFAULT_FONT_SIZE);
    localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
    applyFontSize(DEFAULT_FONT_SIZE);
  };

  const handleCreateTag = async () => {
    if (!newTagName.trim()) return;

    try {
      const tag = await createTag({ name: newTagName.trim(), color: newTagColor });
      setTags((prev) => [...prev, tag]);
      setNewTagName("");
      setNewTagColor("#3b82f6");
      setIsAddingTag(false);
    } catch (error) {
      console.error("Failed to create tag:", error);
    }
  };

  const handleDeleteTag = async (tagId: string) => {
    try {
      await deleteTag(tagId);
      setTags((prev) => prev.filter((t) => t.id !== tagId));
    } catch (error) {
      console.error("Failed to delete tag:", error);
    }
  };

  return (
    <div className="min-h-dvh bg-surface-base">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-b-default bg-surface-base/80 backdrop-blur-sm px-6 py-4">
        <div className="flex items-center gap-4">
          <Button asChild variant="ghost" mode="icon" size="sm" aria-label="Go back to home">
            <a href="/">
              <ArrowLeft className="size-5" aria-hidden="true" />
            </a>
          </Button>
          <h1 className="text-xl font-semibold text-t-primary">Settings</h1>
        </div>
      </header>

      {/* Settings Content */}
      <main className="mx-auto max-w-2xl p-6">
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-medium text-t-primary">Dependencies</h2>
          <Panel inset="md"><DependenciesSettings /></Panel>
        </section>

        <section className="mb-8">
          <h2 className="mb-4 text-lg font-medium text-t-primary">Agent files</h2>
          <Panel inset="md" className="flex items-center gap-4">
            <FileCode2 className="size-5 shrink-0 text-t-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-t-secondary">Claude and Codex files</p>
            </div>
            <Button asChild size="sm" variant="outline"><a href="/settings/agent-files">Browse <ExternalLink /></a></Button>
          </Panel>
        </section>
        {/* Theme Section */}
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-medium text-t-primary">Theme</h2>
          <Panel inset="md">
            <ThemeSwitcher />
          </Panel>
        </section>

        {/* Typography Section */}
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-medium text-t-primary">Typography</h2>
          <Panel inset="md">
            <label
              htmlFor="font-size"
              className="block text-sm font-medium text-t-secondary"
            >
              Font size
            </label>
            <div className="mt-2 flex items-center gap-3">
              <Slider
                id="font-size"
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                value={fontSize}
                onChange={(e) => handleFontSizeChange(Number(e.target.value))}
                aria-describedby="font-size-hint"
              />
              <Input
                type="number"
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                value={fontSize}
                onChange={(e) => handleFontSizeChange(Number(e.target.value))}
                className="w-20 tabular-nums"
                aria-label="Font size in pixels"
              />
              <span className="text-sm text-t-tertiary">px</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <p id="font-size-hint" className="text-xs text-t-muted">
                {MIN_FONT_SIZE}-{MAX_FONT_SIZE}
              </p>
              <Button variant="outline" size="sm" onClick={handleResetFontSize}>
                Reset
              </Button>
            </div>
          </Panel>
        </section>

        {/* Terminal Section */}
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-medium text-t-primary">Terminal</h2>
          <Panel inset="md">
            <TerminalSettings />
          </Panel>
        </section>

        {/* Tags Section */}
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-medium text-t-primary">Tags</h2>
          <Panel inset="md">
            <p className="text-sm text-t-tertiary">
              Manage your project tags here. Tags help organize and categorize your projects.
            </p>

            {/* Tags List */}
            <div className="mt-4 space-y-2">
              {isLoading ? (
                <p className="text-sm text-t-tertiary">Loading tags…</p>
              ) : tagsError ? (
                <ReadFailed
                  data-testid="tags-error"
                  what="Your tags could not be read."
                  why={tagsError}
                  onRetry={() => setAttempt((n) => n + 1)}
                />
              ) : tags.length === 0 && !isAddingTag ? (
                <p className="text-sm text-t-tertiary">No tags yet. Create one to get started.</p>
              ) : (
                tags.map((tag) => (
                  <Panel key={tag.id} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className="size-4 rounded-full"
                        style={{ backgroundColor: tag.color }}
                        aria-hidden="true"
                      />
                      <span className="text-sm font-medium text-t-secondary">{tag.name}</span>
                    </div>
                    <Button
                      variant="ghost"
                      mode="icon"
                      size="sm"
                      onClick={() => handleDeleteTag(tag.id)}
                      title="Delete tag"
                      aria-label={`Delete tag ${tag.name}`}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </Panel>
                ))
              )}

              {/* Add Tag Form */}
              {isAddingTag && (
                <Panel inset="md" className="mt-3 space-y-3">
                  <div className="flex items-center gap-2">
                    <ColorPicker value={newTagColor} onChange={setNewTagColor} />
                    <Input
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      placeholder="Tag name…"
                      aria-label="Tag name"
                      className="flex-1"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleCreateTag();
                        } else if (e.key === "Escape") {
                          setIsAddingTag(false);
                          setNewTagName("");
                          setNewTagColor("#3b82f6");
                        }
                      }}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setIsAddingTag(false);
                        setNewTagName("");
                        setNewTagColor("#3b82f6");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleCreateTag}
                      disabled={!newTagName.trim()}
                    >
                      Create Tag
                    </Button>
                  </div>
                </Panel>
              )}
            </div>

            {/* Add Tag Button */}
            {!isAddingTag && (
              <div className="mt-4">
                <Button size="sm" onClick={() => setIsAddingTag(true)}>
                  Add Tag
                </Button>
              </div>
            )}
          </Panel>
        </section>

        {/* Data Section */}
        <section className="mb-8">
          <h2 className="mb-4 text-lg font-medium text-t-primary">Data</h2>
          <Panel inset="md">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-danger">Clear Local Database</p>
                <p className="text-sm text-t-tertiary">
                  Remove all projects and tags from local storage
                </p>
              </div>
              <Button variant="destructive" size="sm">
                Clear Data
              </Button>
            </div>
          </Panel>
        </section>
      </main>
    </div>
  );
}
