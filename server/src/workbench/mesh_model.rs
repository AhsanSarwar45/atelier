//! Bounded indexed mesh contract; mirrored by mesh-artifact.ts.
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Model {
    version: f64,
    kind: String,
    title: String,
    description: Option<String>,
    vertices: Vec<[f64; 3]>,
    meshlets: Vec<Meshlet>,
    camera: Camera,
    duration: f64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Meshlet {
    id: String,
    label: String,
    triangles: Vec<f64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Camera {
    target: [f64; 3],
    distance: f64,
    elevation: f64,
    start_azimuth: f64,
    end_azimuth: f64,
    fov: f64,
    near: f64,
    far: f64,
}
fn range(n: f64, min: f64, max: f64) -> bool {
    n.is_finite() && n >= min && n <= max
}
fn point(p: &[f64; 3]) -> bool {
    p.iter().all(|n| range(*n, -1000.0, 1000.0))
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.encode_utf16().count() <= max
}
fn id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.as_bytes()[0].is_ascii_alphabetic()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
pub fn validate(value: &Value) -> Result<(), String> {
    if value.get("description").is_some_and(Value::is_null) {
        return Err("mesh description must be text, not null".into());
    }
    let m: Model =
        serde_json::from_value(value.clone()).map_err(|e| format!("invalid mesh model: {e}"))?;
    if m.version != 1.0
        || m.kind != "mesh"
        || !text(&m.title, 200)
        || m.description.as_ref().is_some_and(|s| !text(s, 1000))
        || !(3..=4096).contains(&m.vertices.len())
        || !m.vertices.iter().all(point)
        || !(1..=128).contains(&m.meshlets.len())
        || !range(m.duration, 5.0, 120.0)
    {
        return Err("mesh: version 1, a title, 3–4096 vertices bounded to ±1000, 1–128 meshlets and duration 5–120 seconds required".into());
    }
    let c = &m.camera;
    if !point(&c.target)
        || !range(c.distance, 0.0, 1000.0)
        || c.distance == 0.0
        || !range(c.elevation, -80.0, 80.0)
        || !range(c.start_azimuth, -720.0, 720.0)
        || !range(c.end_azimuth, -720.0, 720.0)
        || !range(c.fov, 10.0, 100.0)
        || !range(c.near, 0.0, 2000.0)
        || c.near == 0.0
        || !range(c.far, 0.0, 2000.0)
        || c.far <= c.near
    {
        return Err("mesh camera: bounded target, distance (0,1000], elevation ±80°, azimuth ±720°, FOV 10–100°, and 0 < near < far ≤ 2000 required".into());
    }
    let mut ids = BTreeSet::new();
    let mut count = 0;
    for meshlet in &m.meshlets {
        if !id(&meshlet.id)
            || !ids.insert(&meshlet.id)
            || !text(&meshlet.label, 200)
            || !(3..=384).contains(&meshlet.triangles.len())
            || meshlet.triangles.len() % 3 != 0
            || !meshlet
                .triangles
                .iter()
                .all(|n| range(*n, 0.0, (m.vertices.len() - 1) as f64) && n.fract() == 0.0)
        {
            return Err("meshlet: unique ASCII id, label and 1–128 triangles using valid integer vertex indices required".into());
        }
        count += meshlet.triangles.len() / 3;
        if count > 8192 {
            return Err("mesh exceeds 8192 triangles".into());
        }
        for triangle in meshlet.triangles.chunks_exact(3) {
            let a = m.vertices[triangle[0] as usize];
            let b = m.vertices[triangle[1] as usize];
            let d = m.vertices[triangle[2] as usize];
            let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
            let x = u[1] * v[2] - u[2] * v[1];
            let y = u[2] * v[0] - u[0] * v[2];
            let z = u[0] * v[1] - u[1] * v[0];
            if x * x + y * y + z * z <= 1e-20 {
                return Err("mesh triangles must have nonzero area".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn valid() -> Value {
        json!({"version":1,"kind":"mesh","title":"Triangle","vertices":[[0,0,0],[1,0,0],[0,1,0]],
            "meshlets":[{"id":"a","label":"Front","triangles":[0,1,2]}],
            "camera":{"target":[0,0,0],"distance":5,"elevation":20,"startAzimuth":0,"endAzimuth":360,"fov":50,"near":0.1,"far":100},"duration":15})
    }
    #[test]
    fn accepts_mesh_and_integral_float_indices() {
        let mut m = valid();
        m["meshlets"][0]["triangles"] = json!([0.0, 1.0, 2.0]);
        assert!(validate(&m).is_ok());
    }
    #[test]
    fn rejects_unknown_fields_at_every_level_and_null_description() {
        for pointer in ["/script", "/camera/script", "/meshlets/0/script"] {
            let mut m = valid();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            m.pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(key.into(), json!(true));
            assert!(validate(&m).is_err(), "{pointer}");
        }
        let mut m = valid();
        m["description"] = Value::Null;
        assert!(validate(&m).is_err());
    }
    #[test]
    fn rejects_invalid_geometry_camera_and_indices() {
        for (pointer, bad) in [
            ("/vertices/0", json!([0, 0])),
            ("/vertices/0/0", json!(1001)),
            ("/meshlets/0/triangles", json!([0, 1, 3])),
            ("/meshlets/0/triangles", json!([0, 1, 1.5])),
            ("/meshlets/0/triangles", json!([0, 1, 1])),
            ("/meshlets/0/triangles", json!([0, 1])),
            ("/camera/distance", json!(0)),
            ("/camera/near", json!(100)),
            ("/camera/elevation", json!(81)),
            ("/duration", json!(4)),
        ] {
            let mut m = valid();
            *m.pointer_mut(pointer).unwrap() = bad;
            assert!(validate(&m).is_err(), "{pointer}");
        }
        let mut m = valid();
        m["meshlets"] = json!([m["meshlets"][0].clone(), m["meshlets"][0].clone()]);
        assert!(validate(&m).is_err());
    }
    #[test]
    fn rejects_oversized_triangle_budget() {
        let mut m = valid();
        m["meshlets"] = Value::Array((0..65).map(|i| json!({"id":format!("m{i}"),"label":"Repeated","triangles":(0..384).map(|n| n%3).collect::<Vec<_>>()})).collect());
        assert!(validate(&m).unwrap_err().contains("8192"));
    }
}
