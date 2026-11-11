/** Indexed triangles use counter-clockwise winding when viewed from the front. */
export type MeshPoint = [number, number, number];
export type MeshArtifact = {
  version: 1; kind: 'mesh'; title: string; description?: string;
  vertices: MeshPoint[];
  meshlets: Array<{ id: string; label: string; triangles: number[] }>;
  camera: { target: MeshPoint; distance: number; elevation: number; startAzimuth: number; endAzimuth: number; fov: number; near: number; far: number };
  duration: number;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const range = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const point = (v: unknown): v is MeshPoint => Array.isArray(v) && v.length === 3 && v.every(n => range(n, -1000, 1000));
const label = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200;

export function meshArtifact(value: unknown): MeshArtifact | null {
  if (!object(value) || !fields(value, ['version', 'kind', 'title', 'description', 'vertices', 'meshlets', 'camera', 'duration'])
    || value.version !== 1 || value.kind !== 'mesh' || !label(value.title)
    || (value.description !== undefined && (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1000))
    || !Array.isArray(value.vertices) || value.vertices.length < 3 || value.vertices.length > 4096 || !value.vertices.every(point)
    || !Array.isArray(value.meshlets) || value.meshlets.length < 1 || value.meshlets.length > 128 || !range(value.duration, 5, 120)) return null;
  const vertices = value.vertices;
  const c = value.camera;
  if (!object(c) || !fields(c, ['target', 'distance', 'elevation', 'startAzimuth', 'endAzimuth', 'fov', 'near', 'far'])
    || !point(c.target) || !range(c.distance, 0, 1000) || c.distance === 0 || !range(c.elevation, -80, 80)
    || !range(c.startAzimuth, -720, 720) || !range(c.endAzimuth, -720, 720) || !range(c.fov, 10, 100)
    || !range(c.near, 0, 2000) || c.near === 0 || !range(c.far, 0, 2000) || c.far <= c.near) return null;
  const ids = new Set<string>();
  let count = 0;
  for (const m of value.meshlets) {
    if (!object(m) || !fields(m, ['id', 'label', 'triangles']) || typeof m.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(m.id)
      || ids.has(m.id) || !label(m.label) || !Array.isArray(m.triangles) || m.triangles.length < 3 || m.triangles.length > 384 || m.triangles.length % 3 !== 0
      || !m.triangles.every(n => range(n, 0, vertices.length - 1) && Number.isInteger(n))) return null;
    ids.add(m.id);
    count += m.triangles.length / 3;
    if (count > 8192) return null;
    for (let i = 0; i < m.triangles.length; i += 3) {
      const a = vertices[m.triangles[i]], b = vertices[m.triangles[i + 1]], d = vertices[m.triangles[i + 2]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      const x = u[1] * v[2] - u[2] * v[1], y = u[2] * v[0] - u[0] * v[2], z = u[0] * v[1] - u[1] * v[0];
      if (x * x + y * y + z * z <= 1e-20) return null;
    }
  }
  return value as MeshArtifact;
}
