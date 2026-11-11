import { describe, expect, it } from 'vitest';
import { advanceScene, interpolatePose, sceneFrames } from '../scene-playback';
import { visualArtifact, type SceneArtifact } from '../visual-artifacts';
import cache from '../../../tests/fixtures/cache-scenarios.json';
const artifact = visualArtifact(cache) as SceneArtifact;

describe('scene playback', () => {
  it('resolves each scenario independently and can seek backwards without history', () => {
    const hit = sceneFrames(artifact, artifact.scenarios![0]!.steps);
    const miss = sceneFrames(artifact, artifact.scenarios![1]!.steps);
    expect(hit.at(-1)!.poses.request).toMatchObject({ along: 'hit', progress: 1 });
    expect(miss[0]!.poses.request).toMatchObject({ along: 'miss', progress: 0 });
    expect(hit[0]!.poses.request).toMatchObject({ along: 'hit', progress: 0 });
  });
  it('carries omitted properties forward, but clears a route for explicit translation', () => {
    const copy = structuredClone(artifact);
    copy.states[1]!.changes = [{ element: 'request', opacity: .5 }];
    copy.states[2]!.changes = [{ element: 'request', x: 20 }];
    const frames = sceneFrames(copy, copy.scenarios![0]!.steps);
    expect(frames[1]!.poses.request).toMatchObject({ along: 'hit', opacity: .5 });
    expect(frames[2]!.poses.request).toMatchObject({ x: 20, opacity: .5 });
    expect(frames[2]!.poses.request!.along).toBeUndefined();
  });
  it('uses elapsed time, handles zero-duration steps, and stops exactly at the end', () => {
    expect(advanceScene(0, 1, [0, 2, 4])).toBe(.5);
    expect(advanceScene(.5, 3, [0, 2, 4])).toBe(1.5);
    expect(advanceScene(0, 0, [0, 0, 0])).toBe(2);
    expect(advanceScene(0, 100, [0, 2, 4])).toBe(2);
    expect(advanceScene(0, 10, [0])).toBe(0);
  });
  it('interpolates distance along a route for partial scrubs', () => {
    const frames = sceneFrames(artifact, ['hit-start', 'hit-response']);
    expect(interpolatePose(frames[0]!.poses.request!, frames[1]!.poses.request!, .5)).toMatchObject({ along: 'hit', progress: .5 });
  });
});
