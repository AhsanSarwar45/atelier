"use client";

import { useState, useEffect, useCallback, useRef } from "react";

import * as api from "@/lib/api";
import {
  getProjectsWithTags,
  createProject,
  type CreateProjectInput,
} from "@/lib/db";
import type { Project, Tag } from "@/types";

interface UseProjectsResult {
  projects: Project[];
  isLoading: boolean;
  error: Error | null;
  showArchived: boolean;
  refetch: () => Promise<void>;
  addProject: (input: CreateProjectInput) => Promise<Project>;
  updateProjectTags: (projectId: string, tags: Tag[]) => void;
  archiveProject: (id: string) => Promise<void>;
  unarchiveProject: (id: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  toggleShowArchived: () => void;
}

export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const loadingRef = useRef(0);
  const showArchivedRef = useRef(false);

  // Keep ref in sync with state
  useEffect(() => { showArchivedRef.current = showArchived; }, [showArchived]);

  const fetchProjects = useCallback(async () => {
    const loadId = ++loadingRef.current;
    try {
      setError(null);
      const data = await getProjectsWithTags(showArchivedRef.current);
      if (loadId !== loadingRef.current) return;
      setProjects(data);
      setIsLoading(false);
    } catch (err) {
      if (loadId !== loadingRef.current) return;
      setError(err instanceof Error ? err : new Error("Failed to fetch projects"));
      setIsLoading(false);
    }
  }, []);

  const addProject = useCallback(
    async (input: CreateProjectInput): Promise<Project> => {
      const newProject = await createProject(input);
      await fetchProjects();
      return newProject;
    },
    [fetchProjects]
  );

  const updateProjectTags = useCallback((projectId: string, tags: Tag[]) => {
    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectId ? { ...project, tags } : project
      )
    );
  }, []);

  const archiveProject = useCallback(async (id: string) => {
    await api.projects.archive(id);
    await fetchProjects();
  }, [fetchProjects]);

  const unarchiveProject = useCallback(async (id: string) => {
    await api.projects.unarchive(id);
    await fetchProjects();
  }, [fetchProjects]);

  const deleteProject = useCallback(async (id: string) => {
    await api.projects.delete(id);
    await fetchProjects();
  }, [fetchProjects]);

  const toggleShowArchived = useCallback(() => {
    setShowArchived(prev => !prev);
  }, []);

  // Fetch projects on mount and when showArchived changes
  useEffect(() => {
    fetchProjects();
  }, [fetchProjects, showArchived]);

  return {
    projects,
    isLoading,
    error,
    showArchived,
    refetch: fetchProjects,
    addProject,
    updateProjectTags,
    archiveProject,
    unarchiveProject,
    deleteProject,
    toggleShowArchived,
  };
}
