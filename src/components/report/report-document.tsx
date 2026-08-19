/**
 * The whole report: a title, then the six fixed parts in the one order the
 * spec always carries them in — `build.py`'s `build()`. The three
 * cross-cutting concerns (term tooltips, the shared reply/override state,
 * the picture viewer) wrap the whole document once here rather than each
 * part reaching for its own, since a chip in "What I need from you" and an
 * override button in "Decisions" have to share one composed reply.
 */
import { TooltipProvider } from '@/components/ui/tooltip';

import { GlossaryProvider } from './glossary';
import { LightboxProvider } from './lightbox';
import { ActionCard } from './parts/action-card';
import { ContentSectionCard } from './parts/content-section';
import { DecisionsCard } from './parts/decisions-card';
import { NextCard } from './parts/next-card';
import { StatusCard } from './parts/status-card';
import { ReplyProvider } from './reply';
import type { ReportSpec } from './types';

export function ReportDocument({ spec }: { spec: ReportSpec }) {
  return (
    <TooltipProvider>
      <GlossaryProvider terms={spec.glossary}>
        <LightboxProvider>
          <ReplyProvider>
            <div data-testid="report-column" className="mx-auto flex w-full max-w-[72ch] flex-col gap-5">
              <header className="grid gap-1">
                {spec.eyebrow && (
                  <p className="text-xs font-bold uppercase tracking-wide text-t-muted">{spec.eyebrow}</p>
                )}
                <h1 className="text-2xl font-bold tracking-tight text-t-primary">{spec.title}</h1>
              </header>

              {/* Stable ids on the fixed parts, matching the Reports tab's table of
                  contents (bw-7ks.21.4) — the same five names it scrolls to. */}
              <ActionCard actions={spec.actions} id="act" />
              <StatusCard status={spec.status} id="stat" />

              {spec.content.map((section) => (
                <ContentSectionCard key={section.id} section={section} />
              ))}

              <DecisionsCard decisions={spec.decisions} id="dec" />
              <NextCard next={spec.next} id="next" />
            </div>
          </ReplyProvider>
        </LightboxProvider>
      </GlossaryProvider>
    </TooltipProvider>
  );
}
