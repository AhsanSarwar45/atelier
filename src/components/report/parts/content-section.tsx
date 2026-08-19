/**
 * One of the report's own sections — the middle, variable-length part of the
 * six. A section is just a label, an optional lead sentence, and whatever
 * blocks it holds; all the actual drawing is the block dispatcher's job.
 */
import { BlockList } from '../blocks';
import { Gloss } from '../glossary';
import { ReportCard } from '../report-card';
import type { ContentSection } from '../types';

export function ContentSectionCard({ section }: { section: ContentSection }) {
  return (
    <ReportCard id={section.id} kind="content" label={section.label}>
      {section.lead && (
        <p className="text-sm text-t-secondary">
          <Gloss text={section.lead} />
        </p>
      )}
      <BlockList blocks={section.blocks} />
    </ReportCard>
  );
}
