import { Box3, Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { meshArtifact, type MeshArtifact } from './mesh-artifact';

export type MeshletBound = {
  id: string; label: string; triangles: number[];
  center: Vector3; radius: number; axis: Vector3; halfAngle: number; coneEnabled: boolean; normals: Vector3[];
};
export type MeshletClassification = {
  status: 'kept' | 'frustum' | 'backface';
  planeIndex: number; planeDistance: number; planeDistances: number[];
  coneDot: number; coneThreshold: number; coneMargin: number; epsilon: number;
};

/** AABB midpoint + farthest vertex gives a conservative sphere, not a minimum sphere. */
export function prepareMesh(model: MeshArtifact): MeshletBound[] {
  if (!meshArtifact(model)) throw new Error('Invalid mesh artifact');
  const vertices = model.vertices.map(p => new Vector3(...p));
  return model.meshlets.map(m => {
    const points = [...new Set(m.triangles)].map(i => vertices[i]);
    const center = new Box3().setFromPoints(points).getCenter(new Vector3());
    const radius = Math.max(...points.map(p => p.distanceTo(center)));
    const normals: Vector3[] = [];
    for (let i = 0; i < m.triangles.length; i += 3) {
      const [a, b, c] = m.triangles.slice(i, i + 3).map(n => vertices[n]);
      normals.push(b.clone().sub(a).cross(c.clone().sub(a)).normalize());
    }
    const axis = normals.reduce((sum, n) => sum.add(n), new Vector3());
    const usable = axis.lengthSq() > 1e-20;
    if (usable) axis.normalize(); else axis.set(0, 1, 0);
    const minDot = Math.min(...normals.map(n => n.dot(axis)));
    const halfAngle = usable ? Math.acos(Math.max(-1, Math.min(1, minDot))) : Math.PI;
    return { ...m, center, radius, axis, halfAngle, coneEnabled: usable && minDot > 1e-8, normals };
  });
}

/** Orbit azimuth zero is +Z; elevation is measured above the XZ plane. */
export function meshCamera(model: MeshArtifact, progress: number, aspect: number, fovOverride = model.camera.fov): PerspectiveCamera {
  const c = model.camera;
  const t = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const azimuth = (c.startAzimuth + (c.endAzimuth - c.startAzimuth) * t) * Math.PI / 180;
  const elevation = c.elevation * Math.PI / 180;
  const camera = new PerspectiveCamera(Math.max(10, Math.min(100, fovOverride)), Number.isFinite(aspect) && aspect > 0 ? aspect : 1, c.near, c.far);
  camera.position.set(c.target[0] + c.distance * Math.cos(elevation) * Math.sin(azimuth), c.target[1] + c.distance * Math.sin(elevation), c.target[2] + c.distance * Math.cos(elevation) * Math.cos(azimuth));
  camera.lookAt(new Vector3(...c.target));
  camera.updateMatrixWorld(true);
  return camera;
}

/** Sphere form of meshoptimizer's conservative perspective normal-cone test.
 * https://github.com/zeux/meshoptimizer/blob/master/src/meshoptimizer.h
 * Never rejects the uncertain boundary: epsilon favors keeping extra geometry.
 */
export function classifyMeshlet(bound: MeshletBound, camera: PerspectiveCamera, frustumEnabled = true, coneEnabled = true): MeshletClassification {
  camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const planeDistances = frustum.planes.map(p => p.distanceToPoint(bound.center));
  const planeDistance = Math.min(...planeDistances);
  const planeIndex = planeDistances.indexOf(planeDistance);
  const toCenter = bound.center.clone().sub(camera.getWorldPosition(new Vector3()));
  const coneDot = toCenter.dot(bound.axis);
  const coneThreshold = Math.sin(bound.halfAngle) * toCenter.length() + bound.radius;
  const epsilon = 1e-7 * Math.max(1, bound.radius, toCenter.length());
  const coneMargin = coneDot - coneThreshold;
  const status = frustumEnabled && planeDistance < -bound.radius - epsilon ? 'frustum'
    : coneEnabled && bound.coneEnabled && coneMargin > epsilon ? 'backface' : 'kept';
  return { status, planeIndex, planeDistance, planeDistances, coneDot, coneThreshold, coneMargin, epsilon };
}
