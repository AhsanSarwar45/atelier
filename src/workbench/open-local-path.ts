import { toast } from '@/hooks/use-toast';
import { fs } from '@/lib/api';

/** Open a local path outside Atelier and make failure visible to the reader. */
export function openLocalPath(path: string, target: 'vscode' | 'cursor' | 'finder' = 'finder', line?: number | null): void {
  const opening = line == null ? fs.openExternal(path, target) : fs.openExternal(path, target, line);
  void opening.catch((error: unknown) =>
    toast({
      title: 'Could not open that file',
      description: error instanceof Error ? error.message : path,
      variant: 'destructive',
    }),
  );
}
