# Meshlet geometry and culling

Use `kind: "mesh"` when the question depends on real triangle positions,
viewpoint, or front-facing surfaces. A moving camera and two linked 3D views
show why entire triangle clusters can be rejected. Use `render` instead for
numerical image buffers, and `scene` for a narrated vector illustration.

State the question and takeaway before choosing this artifact. For example:
“Which meshlets can this camera skip? A cluster can be skipped when its whole
bounding sphere is outside the frustum, or its entire normal cone faces away.”
A retained meshlet is only a candidate for rendering; it is not necessarily
visible after depth testing.

The overview keeps all clusters visible and shows the rendering camera's
frustum. The camera view uses that camera and omits rejected clusters. Orbit
the overview to inspect geometry without changing the rendering camera.
Play moves the rendering camera continuously; pause or scrub to inspect a
particular angle. Select a cluster to inspect its sphere, face normals, normal
cone and rejection evidence. Use the culling toggles and field of view control
to compare the tests. Labels and geometry remain meaningful while paused.

## Contract

An artifact is one JSON object. Unknown fields are rejected at every level.
No code, shaders, remote assets, textures, author-supplied bounds or custom
culling rules are accepted.

- `version`: `1`; `kind`: `"mesh"`.
- `title`: nonempty string, at most 200 characters.
- `description`: optional nonempty string, at most 1,000 characters. Explain
  the geometry, units, intended comparison and omitted rendering stages.
- `vertices`: 3–4,096 points, each `[x,y,z]`. Coordinates must be finite and
  have absolute value at most 1,000. All coordinates share one world space.
- `meshlets`: 1–128 objects with only `id`, `label`, and `triangles`.
  IDs start with an ASCII letter, then contain letters, digits, underscores
  or hyphens, with at most 64 characters; IDs are unique. Labels are nonempty,
  at most 200 characters. `triangles` is a flat array of global vertex indices,
  three per triangle, containing 3–384 entries (1–128 triangles). Every index
  is an integer referring to `vertices`. The whole model allows at most 8,192
  triangles. Triangles are counter-clockwise when viewed from their front.
  Degenerate triangles are rejected: the squared cross-product magnitude
  must exceed `1e-20`. Duplicate points are allowed if triangles remain valid.
- `camera`: object with exactly the fields below.
  - `target`: `[x,y,z]` with the same coordinate limits as vertices.
  - `distance`: greater than zero and at most 1,000.
  - `elevation`: degrees above the XZ plane, from -80 to 80.
  - `startAzimuth`, `endAzimuth`: degrees from -720 to 720. Zero places the
    camera along +Z from the target; positive angles move toward +X. Playback
    interpolates these angles directly, so 0 to 360 makes a full turn.
  - `fov`: vertical field of view in degrees, 10–100.
  - `near`: positive near clipping distance.
  - `far`: greater than `near`, at most 2,000.
- `duration`: seconds for the camera traversal, 5–120. This controls playback,
  not measured GPU performance.

Optional fields may be omitted, but may not be null. Keep the whole artifact
under the presenter's 1 MiB file limit.

## How the tests work

Atelier calculates each sphere from the midpoint of the cluster's axis-aligned
bounding box and the farthest referenced vertex. This encloses every triangle
but is not a minimum bounding sphere. Normalized triangle normals determine
an average cone axis; its half-angle encloses every normal. If the average
vanishes, or the normals cannot fit in the chosen forward hemisphere, cone
rejection is disabled. This can retain extra clusters safely.

The frustum test uses signed distances from the sphere center to six normalized
camera planes. A meshlet is rejected only if a distance is less than minus its
radius, beyond a small numerical tolerance. Crossing a plane is insufficient:
the whole sphere must be outside.

For the perspective normal-cone test, let `v = center - cameraPosition`, `a`
be the unit normal-cone axis, `h` its half-angle, and `r` the sphere radius.
Reject only when `dot(v,a) > sin(h) * length(v) + r`, beyond tolerance. The
radius term accounts for the different viewing directions across the cluster;
testing only the center direction would incorrectly reject some geometry.
Frustum rejection takes precedence when both tests fail. Counts therefore do
not double-count rejected meshlets.

Both tests deliberately keep uncertain boundary cases. Retained geometry can
include off-screen triangles, back-facing triangles, and occluded surfaces.
This widget does not implement occlusion culling, LOD selection, mesh-shader
execution, automatic meshlet partitioning, or GPU timing. The supplied meshlet
partition is illustrative, not an optimized meshoptimizer partition. WebGL
renders the view; the displayed cluster decisions are computed on the CPU.

## Complete examples

Read the JSON resources rather than reconstructing them from a screenshot:

- [mesh-torus.json](mesh-torus.json): vertical XY torus with major radius 2.2,
  tube radius 0.65, 512 vertices and 1,024 triangles. The 32 meshlets each
  contain 32 triangles. The initial 36-degree field of view keeps the shape
  understandable. Play to orbit, then narrow Field of view to 18 degrees to
  demonstrate frustum rejection. Zero frustum rejections at the wider setting
  is valid: conservative spheres can all intersect the frustum. The overview
  retains the whole torus when the camera view is cropped.
- [mesh-folded.json](mesh-folded.json): eight one-sided folded facade panels,
  200 vertices and 256 triangles. Alternating panels have different normals,
  so an oblique view retains some folds and rejects others. From behind,
  backface rejection can remove the entire facade. This is an open surface,
  not a solid wall, and it does not test occlusion. Its initial field of view
  is also 36 degrees; narrow it to compare frustum rejection.

Submit either JSON file with `atelier tool present artifact --file FILE`.
Verify actual geometry moves during playback and pause at multiple angles.
Inspect a selected retained cluster and each available rejection reason.
Do not replace camera motion with captions or use arbitrary colors as proof.

## Primary references

- [meshoptimizer bounds API](https://github.com/zeux/meshoptimizer/blob/master/src/meshoptimizer.h): conservative sphere-based perspective cone rejection.
- [Three.js Frustum](https://threejs.org/docs/#api/en/math/Frustum): normalized frustum planes and sphere tests.
- [Three.js PerspectiveCamera](https://threejs.org/docs/#api/en/cameras/PerspectiveCamera): vertical field of view, aspect ratio and clipping planes.
