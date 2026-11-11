/**
 * Project stored in local SQLite
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  localPath?: string;
  tags: Tag[];
  lastOpened: string;
  createdAt: string;
  archivedAt?: string;
  /**
   * True for a project registered by the e2e test suite rather than a
   * real user. The server excludes these from the default project list —
   * this field exists only to match what `GET /api/projects` returns when
   * asked for test projects explicitly; the frontend does not filter on it.
   */
  isTest?: boolean;
}

/**
 * Tag stored in local SQLite
 */
export interface Tag {
  id: string;
  name: string;
  color: string;
}
