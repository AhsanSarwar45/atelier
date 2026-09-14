/**
 * Copies one page of an account's provider settings into other accounts of
 * the same provider, key for key (bw-2t1c.11).
 */
'use client';

import { useState } from 'react';

import { Copy, Loader2 } from 'lucide-react';

import { pagesFor, type Brand } from '@/components/settings/provider-schema';
import { getPath, readSettings, writeSettings } from '@/components/settings/provider-settings-api';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import type { ProfileChoice } from '@/workbench/protocol';

function said(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function CopyToAccounts({ brand, from, profiles, page }: { brand: Brand; from: string; profiles: ProfileChoice[]; page: string }) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const others = profiles.filter((p) => p.id !== from);
  const pageDef = pagesFor(brand).find((p) => p.id === page);
  if (others.length === 0 || !pageDef) return null;

  const copy = async () => {
    setBusy(true);
    try {
      const view = await readSettings(brand, { kind: 'account', profileId: from });
      const mine = view.files.find((f) => f.layer === 'user')?.value ?? {};
      const patch: Record<string, unknown> = {};
      for (const group of pageDef.groups) {
        for (const def of group.settings) {
          const value = getPath(mine, def.key);
          patch[def.key] = value === undefined ? null : value;
        }
      }
      for (const id of chosen) await writeSettings(brand, { kind: 'account', profileId: id }, 'user', patch);
      toast({ title: `Copied to ${chosen.size} ${chosen.size === 1 ? 'account' : 'accounts'}` });
      setOpen(false);
      setChosen(new Set());
    } catch (e) {
      toast({ title: 'Not copied', description: said(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid={`copy-to-accounts-${brand}`}>
        <Copy /> Copy to…
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="copy-to-accounts-dialog">
          <DialogHeader>
            <DialogTitle>Copy {pageDef.label.toLowerCase()} to</DialogTitle>
          </DialogHeader>
          <ul className="divide-y divide-border rounded-md border border-border">
            {others.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2">
                <Checkbox
                  id={`copy-to-${p.id}`}
                  checked={chosen.has(p.id)}
                  onCheckedChange={(c) =>
                    setChosen((was) => {
                      const next = new Set(was);
                      if (c === true) next.add(p.id);
                      else next.delete(p.id);
                      return next;
                    })
                  }
                  data-testid={`copy-to-${p.id}`}
                />
                <label htmlFor={`copy-to-${p.id}`} className="flex-1 cursor-pointer text-sm text-t-primary">
                  {p.name}
                </label>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || chosen.size === 0} onClick={() => void copy()} data-testid="copy-to-accounts-confirm">
              {busy && <Loader2 className="animate-spin" />} Copy
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
