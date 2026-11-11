import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { meshArtifact, type MeshArtifact } from '../mesh-artifact';
import { classifyMeshlet, meshCamera, prepareMesh } from '../mesh-geometry';

const model = (): MeshArtifact => ({ version: 1, kind: 'mesh', title: 'Triangle', vertices: [[-1,-1,0],[1,-1,0],[0,1,0]], meshlets: [{id:'front',label:'Front',triangles:[0,1,2]}], camera: {target:[0,0,0],distance:10,elevation:0,startAzimuth:0,endAzimuth:180,fov:60,near:0.1,far:100},duration:20 });
const cameraAt = (position: Vector3) => { const c = new PerspectiveCamera(60, 1, 0.1, 100); c.position.copy(position); c.lookAt(0,0,0); c.updateMatrixWorld(true); return c; };

describe('mesh artifact validation', () => {
  it('accepts indexed geometry and rejects malformed or degenerate triangles', () => {
    expect(meshArtifact(model())).not.toBeNull();
    for (const triangles of [[0,1], [0,1,3], [0,0,1], [0,1,1.5]]) {
      const m = model(); m.meshlets[0].triangles = triangles; expect(meshArtifact(m)).toBeNull();
    }
    const collinear = model(); collinear.vertices[2] = [0,-1,0]; expect(meshArtifact(collinear)).toBeNull();
  });
  it('rejects supplied bounds, duplicate ids, nonfinite values and invalid cameras', () => {
    expect(meshArtifact({...model(), bounds:{radius:1}})).toBeNull();
    const duplicate = model(); duplicate.meshlets.push({...duplicate.meshlets[0]}); expect(meshArtifact(duplicate)).toBeNull();
    for (const patch of [{near:0},{near:100,far:100},{distance:0},{fov:101},{elevation:81},{target:[0,Infinity,0]}]) {
      const m = model(); Object.assign(m.camera,patch); expect(meshArtifact(m)).toBeNull();
    }
    expect(meshArtifact({...model(), description:null})).toBeNull();
    expect(meshArtifact({...model(), duration:4})).toBeNull();
  });
});

describe('conservative meshlet bounds and culling', () => {
  it('contains every vertex and derives the cone from winding', () => {
    const m = model(), bound = prepareMesh(m)[0];
    for (const p of m.vertices) expect(new Vector3(...p).distanceTo(bound.center)).toBeLessThanOrEqual(bound.radius);
    expect(bound.axis.toArray()).toEqual([0,0,1]); expect(bound.halfAngle).toBe(0); expect(bound.coneEnabled).toBe(true);
    expect(classifyMeshlet(bound, meshCamera(m,0,1)).status).toBe('kept');
    const rejected = classifyMeshlet(bound, meshCamera(m,1,1));
    expect(rejected.status).toBe('backface'); expect(rejected.coneDot).toBeCloseTo(10); expect(rejected.coneThreshold).toBeCloseTo(Math.sqrt(2));
    expect(classifyMeshlet(bound,meshCamera(m,1,1),true,false).status).toBe('kept');
  });
  it('rejects a sphere only when fully outside a frustum plane', () => {
    const m = model(), bound = prepareMesh(m)[0], camera = meshCamera(m,0,1);
    bound.center.x = 30;
    const rejected = classifyMeshlet(bound,camera);
    expect(rejected.status).toBe('frustum'); expect(rejected.planeDistance).toBeLessThan(-bound.radius);
    expect(rejected.planeDistances).toHaveLength(6);
    expect(classifyMeshlet(bound,camera,false,false).status).toBe('kept');
    bound.radius = 40; expect(classifyMeshlet(bound,camera).status).toBe('kept');
  });
  it('disables the normal cone for opposing normals and retains camera-inside spheres', () => {
    const m = model(); m.meshlets[0].triangles.push(2,1,0);
    const b = prepareMesh(m)[0]; expect(b.coneEnabled).toBe(false); expect(classifyMeshlet(b,meshCamera(m,1,1)).status).toBe('kept');
    const single = prepareMesh(model())[0]; expect(classifyMeshlet(single,cameraAt(new Vector3(0,0,-0.5)),false).status).toBe('kept');
  });
  it('never cone-culls a front-facing triangle across deterministic viewpoints', () => {
    const m = model(); m.vertices.push([0,0,1]); m.meshlets[0].triangles.push(0,3,1);
    const bound = prepareMesh(m)[0];
    for (let i = 0; i < 160; i++) {
      const angle = i * Math.PI * 2 / 160;
      const camera = cameraAt(new Vector3(12*Math.sin(angle), 7*Math.sin(angle*3), 12*Math.cos(angle)));
      const result = classifyMeshlet(bound,camera,false,true);
      if (result.status === 'backface') {
        for (let t = 0; t < bound.normals.length; t++) {
          const point = new Vector3(...m.vertices[m.meshlets[0].triangles[t*3]]);
          expect(bound.normals[t].dot(camera.position.clone().sub(point))).toBeLessThan(0);
        }
      }
    }
  });
  it('orbits actual camera matrices and changes frustum with aspect and fov', () => {
    const m = model(); expect(meshCamera(m,0,1).position.toArray()).toEqual([0,0,10]);
    expect(meshCamera(m,0.5,1).position.x).toBeCloseTo(10);
    const b = prepareMesh(m)[0]; b.center.x = 6;
    expect(classifyMeshlet(b,meshCamera(m,0,1,20),true,false).status).toBe('frustum');
    expect(classifyMeshlet(b,meshCamera(m,0,2,90),true,false).status).toBe('kept');
  });
});
