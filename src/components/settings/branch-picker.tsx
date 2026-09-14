/**
 * Branch choices for a project's settings: one branch from the repo's list,
 * or a set of them. Either can name a branch the repo does not have yet
 * (bw-nin9.4).
 */
'use client';

import { useState } from 'react';

import { X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const NEW = '__new__';

function NewBranchName({ onDone, testid }: { onDone: (name: string | null) => void; testid: string }) {
  const [name, setName] = useState('');
  const commit = () => onDone(name.trim() || null);
  return (
    <Input
      autoFocus
      aria-label="New branch name"
      placeholder="branch name"
      value={name}
      onChange={(e) => setName(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') onDone(null);
      }}
      className="w-full font-mono text-xs sm:w-72"
      data-testid={`${testid}-new`}
    />
  );
}

export function BranchSelect({ id, value, branches, onChange, testid }: { id: string; value: string; branches: string[]; onChange: (name: string) => void; testid: string }) {
  const [naming, setNaming] = useState(false);
  if (naming) {
    return (
      <NewBranchName
        testid={testid}
        onDone={(name) => {
          if (name) onChange(name);
          setNaming(false);
        }}
      />
    );
  }
  const listed = value && !branches.includes(value) ? [value, ...branches] : branches;
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => {
        if (v === NEW) setNaming(true);
        else onChange(v);
      }}
    >
      <SelectTrigger id={id} className="w-full font-mono text-xs sm:w-72" data-testid={testid}>
        <SelectValue placeholder="Choose a branch" />
      </SelectTrigger>
      <SelectContent>
        {listed.map((b) => (
          <SelectItem key={b} value={b}>
            {b}
          </SelectItem>
        ))}
        <SelectItem value={NEW}>New branch…</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function BranchesPicker({ id, value, branches, onChange, testid }: { id: string; value: string[]; branches: string[]; onChange: (names: string[]) => void; testid: string }) {
  const [naming, setNaming] = useState(false);
  const left = branches.filter((b) => !value.includes(b));
  const add = (name: string) => {
    if (name && !value.includes(name)) onChange([...value, name]);
  };
  return (
    <div className="flex w-full flex-col gap-2 sm:w-72" data-testid={testid}>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((b) => (
            <Badge key={b} variant="secondary" className="gap-1 font-mono text-xs" data-testid={`${testid}-${b}`}>
              {b}
              <Button variant="ghost" size="xs" className="h-4 w-4 p-0" aria-label={`Remove ${b}`} onClick={() => onChange(value.filter((v) => v !== b))}>
                <X className="size-3" />
              </Button>
            </Badge>
          ))}
        </div>
      )}
      {naming ? (
        <NewBranchName
          testid={testid}
          onDone={(name) => {
            if (name) add(name);
            setNaming(false);
          }}
        />
      ) : (
        <Select
          value=""
          onValueChange={(v) => {
            if (v === NEW) setNaming(true);
            else add(v);
          }}
        >
          <SelectTrigger id={id} className="w-full font-mono text-xs" data-testid={`${testid}-add`}>
            <SelectValue placeholder="Add a branch" />
          </SelectTrigger>
          <SelectContent>
            {left.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
            <SelectItem value={NEW}>New branch…</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
