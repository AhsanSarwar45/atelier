'use client';

import { Download } from 'lucide-react';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { fs } from '@/lib/api';
import { toast } from '@/hooks/use-toast';
import { mediaUrl } from '@/workbench/attachment-store';

/** Read the original bytes, including binary files and text beyond the preview limit. */
async function downloadFile(path: string): Promise<void> {
  try {
    const response = await fetch(mediaUrl(path));
    // The range-based media endpoint returns 416 for an empty file. Confirm
    // its size through the reader before treating that refusal as empty bytes.
    const empty = response.status === 416 && (await fs.read(path)).size === 0;
    if (!response.ok && !empty) throw new Error(await response.text());
    const url = URL.createObjectURL(empty ? new Blob([]) : await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = path.split(/[\\/]/).pop() || 'download';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Keep the blob alive until the browser has accepted the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    toast({
      title: "Couldn't download file. Try again.",
      description: error instanceof Error ? error.message : undefined,
      variant: 'destructive',
    });
  }
}

export function DownloadFileItem({ path, disabled, testId }: {
  path: string;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <DropdownMenuItem data-testid={testId} disabled={disabled} onSelect={() => void downloadFile(path)}>
      <Download aria-hidden="true" /> Download
    </DropdownMenuItem>
  );
}
