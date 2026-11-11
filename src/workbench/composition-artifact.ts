/** Executable presentations are isolated documents, never React components on the app origin. */
export const COMPOSITION_LIMIT = 8 * 1024 * 1024;
export type CompositionArtifact = {
  version: 1; kind: 'composition'; title: string; description?: string;
  width: number; height: number; html: string;
};
export function compositionArtifact(value: unknown): CompositionArtifact | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const text = (s: unknown, max: number) => typeof s === 'string' && s.trim().length > 0 && s.length <= max && new TextEncoder().encode(s).length <= max;
  const dimension = (n: unknown, min: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= 4096;
  if (Object.keys(v).some(k => !['version','kind','title','description','width','height','html'].includes(k))
    || v.version !== 1 || v.kind !== 'composition' || !text(v.title, 200)
    || (v.description !== undefined && !text(v.description, 1000))
    || !dimension(v.width, 160) || !dimension(v.height, 90)
    || !text(v.html, COMPOSITION_LIMIT)) return null;
  return value as CompositionArtifact;
}
