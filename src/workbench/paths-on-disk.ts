/**
 * Which of the addresses written in a conversation are real files, for deciding
 * what in it is worth clicking.
 *
 * `paths.ts` can say what has the shape of an address; only disk can say
 * whether `and/or` is a folder and `docs/plan.md` is a file. This asks, once
 * per address for the life of the tab, and answers from memory ever after — a
 * conversation redraws on every word an agent says, and a question already
 * answered must never be asked twice (bw-khe.13).
 *
 * Every answer is remembered, including "no": a name that is not a file does
 * not become one while the reader is reading, and re-asking would put one
 * request on the wire per redraw for every `and/or` in the transcript.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fs } from '@/lib/api';

/** How many questions are on the wire at once. */
const AT_A_TIME = 6;

/**
 * How long answers are gathered before the conversation is redrawn. A chat can
 * name a hundred files; setting state per answer would redraw it a hundred
 * times.
 */
const GATHER_MS = 80;

/** Answers, and the reader's home, live as long as the tab does. */
const answers = new Map<string, boolean>();
const inFlight = new Set<string>();

let home: string | null = null;
let askingHome: Promise<string> | null = null;

/**
 * The reader's home folder, so an address written with `~` means something.
 * Asked once; a failure leaves it unknown and those addresses stay plain text.
 */
export function homeFolder(): Promise<string> {
  if (home !== null) return Promise.resolve(home);
  askingHome ??= fs
    .roots()
    .then((r) => {
      home = r.home ?? '';
      return home;
    })
    .catch(() => {
      home = '';
      return home;
    });
  return askingHome;
}

/** What this hook hands back: the answers so far, and a way to ask for more. */
export interface Disk {
  /** Whether that address is a real thing. Unknown counts as no. */
  real(absolute: string): boolean;
  /** The reader's home, or empty until it is known. */
  home: string;
  /** Put these addresses in the queue, if they are not already answered. */
  ask(absolute: string[]): void;
}

export function usePathsOnDisk(): Disk {
  // What is known is kept in a module-wide map so two chats share it; this
  // counter is only how a component learns that the map has changed.
  const [, redraw] = useState(0);
  const [homeNow, setHomeNow] = useState(home ?? '');
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const gathered = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void homeFolder().then((h) => {
      if (alive.current) setHomeNow(h);
    });
    return () => {
      alive.current = false;
    };
  }, []);

  const settle = useCallback(() => {
    if (gathered.current) return;
    gathered.current = true;
    setTimeout(() => {
      gathered.current = false;
      if (alive.current) redraw((n) => n + 1);
    }, GATHER_MS);
  }, []);

  const pump = useCallback(() => {
    while (running.current < AT_A_TIME && queue.current.length > 0) {
      const path = queue.current.shift()!;
      running.current++;
      void fs
        .exists(path)
        .then((r) => answers.set(path, Boolean(r.exists)))
        // A question disk would not answer is a name that does not open, which
        // is the text drawn plainly — never an error in a conversation.
        .catch(() => answers.set(path, false))
        .finally(() => {
          running.current--;
          inFlight.delete(path);
          settle();
          pump();
        });
    }
  }, [settle]);

  const ask = useCallback(
    (paths: string[]) => {
      let added = false;
      for (const path of paths) {
        if (answers.has(path) || inFlight.has(path)) continue;
        inFlight.add(path);
        queue.current.push(path);
        added = true;
      }
      if (added) pump();
    },
    [pump],
  );

  const real = useCallback((absolute: string) => answers.get(absolute) === true, []);

  // One value, kept, not built again on every pass. A fresh object here is a
  // fresh `mentions` in the chat, which is every message in the conversation
  // drawn again for one keystroke (bw-2lzj.1).
  return useMemo(() => ({ real, home: homeNow, ask }), [real, homeNow, ask]);
}

/** Forget everything asked. For tests, which must not inherit an old disk. */
export function forgetDisk(): void {
  answers.clear();
  inFlight.clear();
  home = null;
  askingHome = null;
}
