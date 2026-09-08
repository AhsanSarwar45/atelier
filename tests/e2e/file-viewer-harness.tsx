/**
 * The file viewer on its own, with nothing else on the page.
 *
 * The tab that will hold it is another card (bw-g3o3.4) and is being built
 * beside this one, so there is nowhere in the app yet to point a browser at.
 * This is the smallest thing that is still the real component: the same import
 * the tab will use, handed a file, mounted into a page wearing the app's own
 * stylesheet — so what a screenshot shows is the viewer in the live theme and
 * not a drawing of it (bw-g3o3.17).
 */
import { createRoot } from 'react-dom/client';

import { FileViewer, type ViewedFile } from '@/workbench/file-viewer';

interface Harness {
  root: string;
  path: string;
  line: number | null;
  file: ViewedFile;
}

declare global {
  interface Window {
    fileViewerHarness?: Harness;
  }
}

const asked = window.fileViewerHarness;
const host = document.getElementById('harness');
if (asked && host) {
  createRoot(host).render(
    <FileViewer root={asked.root} path={asked.path} line={asked.line} file={asked.file} className="h-full" />,
  );
}
