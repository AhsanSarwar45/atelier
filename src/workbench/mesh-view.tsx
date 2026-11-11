'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Panel } from '@/components/ui/panel';
import type { MeshArtifact } from './mesh-artifact';
import { classifyMeshlet, meshCamera, prepareMesh } from './mesh-geometry';

const aspect = 1.6;
const colors = ['#38bdf8', '#a78bfa', '#34d399', '#fb923c', '#f472b6', '#facc15'];
const statusLabels = { kept: 'Kept', frustum: 'Outside frustum', backface: 'Back-facing' };
const fmt = (n: number) => n.toFixed(3);

export function MeshView({ artifact: model }: { artifact: MeshArtifact }) {
  const bounds = useMemo(() => prepareMesh(model), [model]);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [selected, setSelected] = useState(0);
  const [fov, setFov] = useState(model.camera.fov);
  const [frustum, setFrustum] = useState(true);
  const [cone, setCone] = useState(true);
  const [showBounds, setShowBounds] = useState(true);
  const [error, setError] = useState('');
  const observerRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<HTMLCanvasElement>(null);
  const drawRef = useRef<() => void>(() => {});
  const resetRef = useRef<() => void>(() => {});
  const camera = useMemo(() => meshCamera(model, progress, aspect, fov), [model, progress, fov]);
  const results = useMemo(() => bounds.map(b => classifyMeshlet(b, camera, frustum, cone)), [bounds, camera, frustum, cone]);
  const latest = useRef({ camera, results, selected, showBounds });
  latest.current = { camera, results, selected, showBounds };
  const pick = (index: number) => { setSelected(index); setPlaying(false); };
  const pickRef = useRef(pick); pickRef.current = pick;
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { setReduced(mq.matches); if (mq.matches) setPlaying(false); };
    const hide = () => { if (document.hidden) setPlaying(false); };
    update(); mq.addEventListener('change', update); document.addEventListener('visibilitychange', hide);
    return () => { mq.removeEventListener('change', update); document.removeEventListener('visibilitychange', hide); };
  }, []);
  useEffect(() => {
    if (!playing || reduced) return;
    let handle = 0; let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(.1, (now - previous) / 1000); previous = now;
      setProgress(p => Math.min(1, p + dt / model.duration));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, reduced, model.duration]);
  useEffect(() => { if (progress === 1) setPlaying(false); }, [progress]);
  useEffect(() => { drawRef.current(); }, [camera, results, selected, showBounds]);
  useEffect(() => {
    const canvases = [observerRef.current!, cameraRef.current!];
    const renderers: THREE.WebGLRenderer[] = [];
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#101827');
    const objects: THREE.Mesh[] = []; const wires: THREE.LineSegments[] = [];
    const disposable: Array<{ dispose(): void }> = [];
    let controls: OrbitControls | undefined; let resize: ResizeObserver | undefined;
    const cleanup = () => { resize?.disconnect(); controls?.dispose(); disposable.forEach(d => d.dispose()); renderers.forEach(r => { r.dispose(); r.forceContextLoss(); }); drawRef.current = () => {}; resetRef.current = () => {}; };
    try {
      for (const canvas of canvases) renderers.push(new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true }));
      renderers.forEach(r => r.setPixelRatio(Math.min(2, window.devicePixelRatio)));
      bounds.forEach((bound, index) => {
        const vertices = bound.triangles.flatMap(i => model.vertices[i]!);
        const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: colors[index % colors.length], roughness: .8, side: THREE.DoubleSide, flatShading: true });
        const object = new THREE.Mesh(geometry, material); object.userData.index = index; object.frustumCulled = false; scene.add(object); objects.push(object);
        const wireGeometry = new THREE.WireframeGeometry(geometry);
        const wireMaterial = new THREE.LineBasicMaterial({ color: '#0b1220', transparent: true, opacity: .6 });
        const wire = new THREE.LineSegments(wireGeometry, wireMaterial); wire.frustumCulled = false; scene.add(wire); wires.push(wire);
        disposable.push(geometry, material, wireGeometry, wireMaterial);
      });
      scene.add(new THREE.HemisphereLight('#ffffff', '#42516a', 2.5));
      const light = new THREE.DirectionalLight('#ffffff', 2); light.position.set(4, 8, 6); scene.add(light);
      const target = new THREE.Vector3(...model.camera.target);
      const extent = Math.max(.1, ...bounds.map(b => b.center.distanceTo(target) + b.radius));
      const observer = new THREE.PerspectiveCamera(48, aspect, .01, Math.max(100, extent * 30));
      observer.position.copy(target).add(new THREE.Vector3(1.5, 1.1, 1.6).normalize().multiplyScalar(Math.max(extent * 2.8, model.camera.distance * 1.8)));
      observer.lookAt(target);
      controls = new OrbitControls(observer, canvases[0]!); controls.target.copy(target); controls.update(); controls.saveState();
      const cameraBodyGeometry = new THREE.BoxGeometry(extent * .09, extent * .07, extent * .13);
      const cameraBodyMaterial = new THREE.MeshBasicMaterial({ color: '#f8fafc' });
      const cameraBody = new THREE.Mesh(cameraBodyGeometry, cameraBodyMaterial); scene.add(cameraBody);
      const trackedCamera = new THREE.PerspectiveCamera();
      const helper = new THREE.CameraHelper(trackedCamera); helper.setColors(new THREE.Color('#ffffff'), new THREE.Color('#94a3b8'), new THREE.Color('#22d3ee'), new THREE.Color('#ffffff'), new THREE.Color('#ffffff')); scene.add(helper);
      disposable.push(cameraBodyGeometry, cameraBodyMaterial, helper);
      const sphereGeometry = new THREE.SphereGeometry(1, 20, 12);
      const sphereMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff', wireframe: true, transparent: true, opacity: .3, depthTest: false });
      const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial); scene.add(sphere); disposable.push(sphereGeometry, sphereMaterial);
      const normalGeometry = new THREE.BufferGeometry();
      const normalAttribute = new THREE.Float32BufferAttribute(new Float32Array(Math.max(...bounds.map(b => b.triangles.length)) * 2), 3); normalAttribute.setUsage(THREE.DynamicDrawUsage); normalGeometry.setAttribute('position', normalAttribute);
      const normalMaterial = new THREE.LineBasicMaterial({ color: '#facc15', depthTest: false });
      const normals = new THREE.LineSegments(normalGeometry, normalMaterial); scene.add(normals); disposable.push(normalGeometry, normalMaterial);
      const coneGeometry = new THREE.BufferGeometry();
      const coneAttribute = new THREE.Float32BufferAttribute(new Float32Array(168), 3); coneAttribute.setUsage(THREE.DynamicDrawUsage); coneGeometry.setAttribute('position', coneAttribute);
      const coneMaterial = new THREE.LineBasicMaterial({ color: '#f472b6', transparent: true, opacity: .8, depthTest: false });
      const coneLines = new THREE.LineSegments(coneGeometry, coneMaterial); scene.add(coneLines); disposable.push(coneGeometry, coneMaterial);
      const draw = () => {
        const { camera, results, selected, showBounds } = latest.current;
        trackedCamera.copy(camera); trackedCamera.updateMatrixWorld(true); helper.update();
        cameraBody.position.copy(camera.position); cameraBody.quaternion.copy(camera.quaternion);
        const bound = bounds[selected]!;
        sphere.position.copy(bound.center); sphere.scale.setScalar(bound.radius);
        const normalPoints: number[] = [];
        for (let i = 0; i < bound.triangles.length; i += 3) {
          const center = new THREE.Vector3(); for (let j = 0; j < 3; j++) center.add(new THREE.Vector3(...model.vertices[bound.triangles[i + j]!]!)); center.divideScalar(3);
          const end = center.clone().addScaledVector(bound.normals[i / 3]!, Math.max(.05, bound.radius * .4)); normalPoints.push(...center.toArray(), ...end.toArray());
        }
        normalAttribute.array.set(normalPoints); normalAttribute.needsUpdate = true; normalGeometry.setDrawRange(0, normalPoints.length / 3); normals.frustumCulled = false;
        const conePoints: number[] = [];
        if (bound.coneEnabled) {
          const length = bound.radius * 1.7; const angle = bound.halfAngle; const axis = bound.axis;
          const u = new THREE.Vector3(0, 1, 0); if (Math.abs(axis.dot(u)) > .9) u.set(1, 0, 0); u.cross(axis).normalize(); const v = axis.clone().cross(u).normalize();
          const ring = Array.from({ length: 25 }, (_, i) => bound.center.clone().addScaledVector(axis, length * Math.cos(angle)).addScaledVector(u, length * Math.sin(angle) * Math.cos(i * Math.PI / 12)).addScaledVector(v, length * Math.sin(angle) * Math.sin(i * Math.PI / 12)));
          ring.slice(0, 24).forEach((p, i) => { conePoints.push(...p.toArray(), ...ring[i + 1]!.toArray()); if (i % 6 === 0) conePoints.push(...bound.center.toArray(), ...p.toArray()); });
        }
        coneAttribute.array.set(conePoints); coneAttribute.needsUpdate = true; coneGeometry.setDrawRange(0, conePoints.length / 3); coneLines.frustumCulled = false;
        const size = (renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) => { const w = canvas.clientWidth || 480; const h = w / aspect; if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) renderer.setSize(w, h, false); };
        renderers.forEach((r, i) => size(r, canvases[i]!));
        objects.forEach((object, i) => {
          const mat = object.material as THREE.MeshStandardMaterial; object.visible = true; mat.side = THREE.DoubleSide;
          mat.color.set(results[i]!.status === 'kept' ? colors[i % colors.length]! : results[i]!.status === 'frustum' ? '#64748b' : '#ef4444');
          mat.wireframe = results[i]!.status !== 'kept'; mat.emissive.set(i === selected ? '#505050' : '#000000'); wires[i]!.visible = results[i]!.status === 'kept';
        });
        helper.visible = cameraBody.visible = true; sphere.visible = normals.visible = coneLines.visible = showBounds;
        renderers[0]!.render(scene, observer);
        objects.forEach((object, i) => { object.visible = results[i]!.status === 'kept'; const mat = object.material as THREE.MeshStandardMaterial; mat.side = THREE.FrontSide; mat.wireframe = false; mat.color.set(colors[i % colors.length]!); wires[i]!.visible = object.visible; });
        helper.visible = cameraBody.visible = sphere.visible = normals.visible = coneLines.visible = false;
        renderers[1]!.render(scene, camera);
        // Restore observer visibility so rejected meshlets remain selectable.
        objects.forEach(object => { object.visible = true; (object.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide; });
      };
      drawRef.current = draw; resetRef.current = () => { controls?.reset(); draw(); };
      controls.addEventListener('change', draw);
      const raycaster = new THREE.Raycaster(); let start = { x: 0, y: 0 };
      const down = (event: PointerEvent) => { start = { x: event.clientX, y: event.clientY }; };
      const up = (event: PointerEvent) => {
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
        const canvas = event.currentTarget as HTMLCanvasElement; const rect = canvas.getBoundingClientRect();
        raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), canvas === canvases[0] ? observer : latest.current.camera);
        const candidates = canvas === canvases[0] ? objects : objects.filter((_, i) => latest.current.results[i]!.status === 'kept');
        if (canvas === canvases[1]) candidates.forEach(object => { (object.material as THREE.MeshStandardMaterial).side = THREE.FrontSide; });
        const hit = raycaster.intersectObjects(candidates)[0];
        candidates.forEach(object => { (object.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide; });
        if (hit) pickRef.current(hit.object.userData.index);
      };
      const lost = (event: Event) => { event.preventDefault(); setPlaying(false); setError('3D rendering stopped. Reset the widget to try again.'); };
      canvases.forEach(c => { c.addEventListener('pointerdown', down); c.addEventListener('pointerup', up); c.addEventListener('webglcontextlost', lost); });
      resize = new ResizeObserver(draw); canvases.forEach(c => resize!.observe(c)); draw();
      return () => { canvases.forEach(c => { c.removeEventListener('pointerdown', down); c.removeEventListener('pointerup', up); c.removeEventListener('webglcontextlost', lost); }); cleanup(); };
    } catch { setError('3D rendering is unavailable in this browser. Try a browser with WebGL enabled.'); cleanup(); }
  }, [model, bounds]);
  const selectedBound = bounds[selected]!; const result = results[selected]!;
  const counts = { kept: 0, frustum: 0, backface: 0 }; results.forEach(r => counts[r.status]++);
  const triangles = bounds.reduce((sum, b, i) => sum + (results[i]!.status === 'kept' ? b.triangles.length / 3 : 0), 0);
  const total = bounds.reduce((sum, b) => sum + b.triangles.length / 3, 0);
  return <div data-testid="mesh-artifact" className="space-y-4 p-3 pt-14" data-progress={progress.toFixed(4)}>
    {model.description && <p className="text-sm text-muted-foreground">{model.description}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={reduced || !!error} onClick={() => { if (progress === 1) setProgress(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play camera'}</Button>
      <Button size="sm" variant="outline" onClick={() => { setPlaying(false); setProgress(0); }}>Restart</Button>
      <span className="text-sm tabular-nums">{(progress * model.duration).toFixed(1)} / {model.duration} s</span>
      <Button size="sm" variant="ghost" onClick={() => resetRef.current()}>Reset observer</Button>
    </div>
    <label className="grid gap-2 text-sm">Camera path<Slider aria-label="Camera path" min={0} max={1} step={.001} value={progress} onChange={e => { setPlaying(false); setProgress(Number(e.target.value)); }} /></label>
    {reduced && <p className="text-xs text-muted-foreground">Reduced motion is on. Move the camera with the slider.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel inset="sm" className="min-w-0 space-y-2"><h3 className="text-sm font-medium">Observer view</h3><canvas ref={observerRef} data-testid="mesh-observer" aria-label="3D observer view. Drag to orbit; use the meshlet selector to inspect a cluster." className="block w-full rounded-md" style={{ aspectRatio: aspect, touchAction: 'none' }} /><p className="text-xs text-muted-foreground">Drag to orbit · scroll to zoom · click a meshlet</p></Panel>
      <Panel inset="sm" className="min-w-0 space-y-2"><h3 className="text-sm font-medium">Camera view</h3><canvas ref={cameraRef} data-testid="mesh-camera" aria-label="3D camera view showing surviving meshlets" className="block w-full rounded-md" style={{ aspectRatio: aspect }} /><p className="text-xs text-muted-foreground">Same camera as the white frustum in the observer view</p></Panel>
    </div>
    <p className="text-xs text-muted-foreground">Colored surfaces: kept · gray wireframe: outside frustum · red wireframe: back-facing</p>
    <div className="flex flex-wrap gap-4 text-sm">
      <label className="flex items-center gap-2"><Input className="h-4 w-4" type="checkbox" checked={frustum} onChange={e => setFrustum(e.target.checked)} />Frustum culling</label>
      <label className="flex items-center gap-2"><Input className="h-4 w-4" type="checkbox" checked={cone} onChange={e => setCone(e.target.checked)} />Backface culling</label>
      <label className="flex items-center gap-2"><Input className="h-4 w-4" type="checkbox" checked={showBounds} onChange={e => setShowBounds(e.target.checked)} />Selected bounds</label>
    </div>
    <label className="grid gap-2 text-sm">Field of view: {fov}°<Slider aria-label="Field of view" min={10} max={100} step={1} value={fov} onChange={e => { setPlaying(false); setFov(Number(e.target.value)); }} /></label>
    <p data-testid="mesh-counts" className="text-sm tabular-nums">{counts.kept} kept · {counts.frustum} outside frustum · {counts.backface} back-facing · {triangles} / {total} triangles submitted</p>
    <Panel inset="md" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm"><span>Meshlet</span><Select value={String(selected)} onValueChange={value => pick(Number(value))}><SelectTrigger aria-label="Meshlet" className="w-auto max-w-full"><SelectValue /></SelectTrigger><SelectContent>{bounds.map((b, i) => <SelectItem key={b.id} value={String(i)}>{b.label} — {statusLabels[results[i]!.status]}</SelectItem>)}</SelectContent></Select></div>
      <p className="font-medium" data-testid="mesh-decision">{selectedBound.label}: {statusLabels[result.status]}</p>
      <p className="text-sm">{result.status === 'frustum' ? `Its sphere is entirely outside plane ${result.planeIndex + 1}: signed distance ${fmt(result.planeDistance)} is less than −radius (${fmt(-selectedBound.radius)}).` : result.status === 'backface' ? `All triangle normals face away, including the perspective allowance. Cone test: ${fmt(result.coneDot)} > ${fmt(result.coneThreshold)}.` : 'No enabled test proves this whole cluster invisible. Keep it; clipping, backface rasterization and depth testing still follow.'}</p>
      <p className="text-xs text-muted-foreground">{selectedBound.triangles.length / 3} triangles · bound radius {fmt(selectedBound.radius)} · normal cone half-angle {(selectedBound.halfAngle * 180 / Math.PI).toFixed(1)}°{selectedBound.coneEnabled ? '' : ' (too wide for cone rejection)'}</p>
      <p className="text-xs text-muted-foreground">White sphere: spatial bound · yellow lines: triangle normals · pink cone: normal directions drawn at the bound center</p>
    </Panel>
    <p className="text-xs text-muted-foreground">Computed from this mesh’s triangles. Single-sided geometry; no occlusion test or GPU performance measurement.</p>
  </div>;
}
