/**
 * The file viewer over a real file, reading and writing the real server.
 *
 * The Files tab is being furnished by several cards at once (the tree is
 * bw-g3o3.12, the open-files strip bw-g3o3.14), so there is nowhere in the app
 * yet to point a browser at a file and type into it. This is the smallest thing
 * that is still the whole path: the same viewer the tab will hold, reading
 * `GET /api/fs/read`, kept current by the same folder watch the tab will use,
 * and saving through `PUT /api/fs/write` to a file the test can then read off
 * the disk itself (bw-g3o3.8).
 */
import { useCallback, useEffect, useState } from 'react';

import { createRoot } from 'react-dom/client';

import * as api from '@/lib/api';
import { FileViewer, type ViewedFile } from '@/workbench/file-viewer';
import { useFolderReads } from '@/workbench/use-folder-reads';

interface Harness {
  root: string;
  path: string;
}

declare global {
  interface Window {
    fileEditingHarness?: Harness;
  }
}

function OpenFile({ root, path }: Harness) {
  const [file, setFile] = useState<ViewedFile | null>(null);

  const read = useCallback(async () => {
    const answer = await api.fs.read(path);
    setFile(
      answer.kind === 'text'
        ? {
            kind: 'text',
            text: answer.text ?? '',
            truncated: answer.truncated,
            size: answer.size,
            sha256: answer.sha256,
            mtime: answer.mtime,
          }
        : { kind: 'binary', size: answer.size },
    );
  }, [path]);

  // The folder the file is in, watched the way the tree watches it: the change
  // arrives over the window's one connection, and the five-second look catches
  // whatever the watcher could not see.
  const readAgain = useFolderReads(path.slice(0, path.lastIndexOf('/')), read);
  useEffect(() => {
    void readAgain();
  }, [readAgain]);

  return <FileViewer root={root} path={path} file={file} onSaved={() => void readAgain()} className="h-full" />;
}

const asked = window.fileEditingHarness;
const host = document.getElementById('harness');
if (asked && host) createRoot(host).render(<OpenFile root={asked.root} path={asked.path} />);
