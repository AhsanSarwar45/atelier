/** The deliberately small block an agent writes to put a comparison in chat. */
export interface ComparisonSpec {
  mode: 'side_by_side' | 'wipe';
  before: { path: string; caption?: string };
  after: { path: string; caption?: string };
}

const BLOCK = /```atelier-image-compare\s*\n([\s\S]*?)\n```/g;

function isShot(value: unknown): value is ComparisonSpec['before'] {
  if (!value || typeof value !== 'object') return false;
  const shot = value as Record<string, unknown>;
  return typeof shot.path === 'string' && shot.path.length > 0
    && (shot.caption === undefined || typeof shot.caption === 'string');
}

export function comparisonSpecs(text: string): ComparisonSpec[] {
  const found: ComparisonSpec[] = [];
  const blocks = new RegExp(BLOCK.source, BLOCK.flags);
  let match: RegExpExecArray | null;
  while ((match = blocks.exec(text)) !== null) {
    try {
      const value = JSON.parse(match[1]!) as Record<string, unknown>;
      const mode = value.mode ?? 'side_by_side';
      if ((mode === 'side_by_side' || mode === 'wipe') && isShot(value.before) && isShot(value.after)) {
        found.push({ mode, before: value.before, after: value.after });
      }
    } catch {
      // Invalid blocks remain ordinary visible code so the mistake is legible.
    }
  }
  return found;
}

/** Hide a valid machine block only when a widget was successfully produced. */
export function withoutComparisonSpecs(text: string): string {
  return text.replace(BLOCK, (whole, json: string) => comparisonSpecs(`\`\`\`atelier-image-compare\n${json}\n\`\`\``).length ? '' : whole).trim();
}
