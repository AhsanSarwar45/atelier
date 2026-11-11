import type { SceneArtifact } from './visual-artifacts';

type Change = SceneArtifact['states'][number]['changes'][number];
export type Pose = Required<Pick<Change, 'x' | 'y' | 'opacity' | 'scale' | 'rotate' | 'pathLength'>> & Pick<Change, 'along' | 'progress'>;
const origin: Pose = { x: 0, y: 0, opacity: 1, scale: 1, rotate: 0, pathLength: 1 };

// Resolve from the beginning of THIS scenario. Seeking never depends on what
// the reader happened to play first, including changes omitted by later steps.
export function sceneFrames(artifact: SceneArtifact, steps: string[]) {
  let poses = Object.fromEntries(artifact.elements.map(element => [element.id, { ...origin }]));
  return steps.map(id => {
    const state = artifact.states.find(state => state.id === id)!;
    poses = { ...poses };
    for (const { element, ...change } of state.changes) {
      const previous = { ...poses[element]! };
      if (change.x !== undefined || change.y !== undefined) { delete previous.along; delete previous.progress; }
      if (change.along !== undefined) { previous.x = 0; previous.y = 0; }
      poses[element] = { ...previous, ...change };
    }
    return { state, poses };
  });
}

export function interpolatePose(from: Pose, to: Pose, fraction: number): Pose {
  const pose = { ...to };
  for (const key of ['x', 'y', 'opacity', 'scale', 'rotate', 'pathLength'] as const) pose[key] = from[key] + (to[key] - from[key]) * fraction;
  if (to.along) pose.progress = (from.along === to.along ? from.progress ?? 0 : 0) * (1 - fraction) + (to.progress ?? 0) * fraction;
  return pose;
}

// Duration describes the transition INTO a step, not a timer on its button.
export function advanceScene(position: number, elapsedSeconds: number, durations: number[]): number {
  let next = position;
  while (next < durations.length - 1) {
    const target = Math.floor(next) + 1;
    const duration = durations[target]!;
    const remaining = (target - next) * duration;
    if (duration > 0 && elapsedSeconds < remaining) return next + elapsedSeconds / duration;
    next = target;
    elapsedSeconds -= remaining;
  }
  return next;
}
