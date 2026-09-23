//! One state contract for the board, lifecycle commands and reconciliation.
//! A leaf is done when its deliverable lands. Containers derive state recursively.
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug)]
pub struct Node {
    pub id: String,
    pub status: String,
    pub children: Vec<String>,
    pub started: bool,
    pub container: bool,
    pub error: Option<String>,
}

pub fn normalize(status: &str) -> &str {
    match status {
        "in_review" => "inreview",
        "done" | "resolved" | "fixed" | "finished" => "closed",
        other => other,
    }
}

pub fn aggregate(states: &[&str], started: bool) -> String {
    if states.is_empty() {
        return "open".into();
    }
    let required: Vec<_> = states
        .iter()
        .copied()
        .filter(|s| *s != "cancelled")
        .collect();
    if required.is_empty() {
        return "cancelled".into();
    }
    if required.iter().all(|s| *s == "closed") {
        return "closed".into();
    }
    let remaining: Vec<_> = required
        .iter()
        .copied()
        .filter(|s| *s != "closed")
        .collect();
    if remaining.iter().all(|s| *s == "manager_review") {
        return "manager_review".into();
    }
    if remaining
        .iter()
        .all(|s| matches!(*s, "inreview" | "manager_review"))
    {
        return "inreview".into();
    }
    if !started && required.iter().all(|s| *s == "open") {
        "open".into()
    } else {
        "in_progress".into()
    }
}

#[derive(Default, Debug)]
pub struct Projection {
    pub states: HashMap<String, String>,
    pub errors: HashMap<String, String>,
}

pub fn project(nodes: &[Node]) -> Projection {
    fn visit(
        id: &str,
        nodes: &HashMap<&str, &Node>,
        active: &mut HashSet<String>,
        out: &mut Projection,
    ) -> Result<String, String> {
        if let Some(error) = out.errors.get(id) {
            return Err(error.clone());
        }
        if let Some(state) = out.states.get(id) {
            return Ok(state.clone());
        }
        let node = nodes.get(id).ok_or_else(|| format!("Missing child {id}"))?;
        if !active.insert(id.into()) {
            return Err(format!("Cyclic child relationship at {id}"));
        }
        let state = if let Some(error) = &node.error {
            Err(error.clone())
        } else if node.status == "cancelled" {
            Ok("cancelled".into())
        } else if node.children.is_empty() {
            Ok(if node.container { if node.started { "in_progress" } else { "open" } } else { normalize(&node.status) }.into())
        } else {
            let children: Result<Vec<String>, String> = node
                .children
                .iter()
                .map(|child| visit(child, nodes, active, out))
                .collect();
            children.map(|states| {
                aggregate(
                    &states.iter().map(String::as_str).collect::<Vec<_>>(),
                    node.started,
                )
            })
        };
        active.remove(id);
        match state {
            Ok(state) => {
                out.states.insert(id.into(), state.clone());
                Ok(state)
            }
            Err(error) => {
                out.errors.insert(id.into(), error.clone());
                out.states.insert(id.into(), "in_progress".into());
                Err(error)
            }
        }
    }
    let lookup: HashMap<_, _> = nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    let mut out = Projection::default();
    for node in nodes {
        let _ = visit(&node.id, &lookup, &mut HashSet::new(), &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn landed_work_dictates_parent_state() {
        for (children, started, expected) in [
            (vec!["open", "open"], false, "open"),
            (vec!["closed", "open"], false, "in_progress"),
            (vec!["closed", "closed"], true, "closed"),
            (vec!["closed", "cancelled"], false, "closed"),
            (vec!["cancelled", "cancelled"], false, "cancelled"),
            (vec!["inreview", "open"], false, "in_progress"),
            (
                vec!["inreview", "manager_review", "closed"],
                false,
                "inreview",
            ),
            (vec!["manager_review", "closed"], false, "manager_review"),
            (vec!["open"], true, "in_progress"),
        ] {
            assert_eq!(aggregate(&children, started), expected, "{children:?}");
        }
    }
    fn node(id: &str, status: &str, children: &[&str]) -> Node {
        Node {
            id: id.into(),
            status: status.into(),
            children: children.iter().map(|s| (*s).into()).collect(),
            started: false,
            container: !children.is_empty(),
            error: None,
        }
    }
    #[test]
    fn nested_completion_and_reopening_reach_every_ancestor() {
        let mut nodes = vec![
            node("a", "closed", &["b"]),
            node("b", "open", &["c"]),
            node("c", "in_progress", &[]),
        ];
        assert_eq!(project(&nodes).states["a"], "in_progress");
        nodes[2].status = "closed".into();
        assert_eq!(project(&nodes).states["a"], "closed");
        nodes[2].status = "open".into();
        nodes[0].started = true;
        assert_eq!(project(&nodes).states["a"], "in_progress");
    }
    #[test]
    fn missing_data_and_cycles_never_complete() {
        for nodes in [
            vec![node("a", "closed", &["missing"])],
            vec![node("a", "open", &["b"]), node("b", "open", &["a"])],
        ] {
            let result = project(&nodes);
            assert_eq!(result.states["a"], "in_progress");
            assert!(result.errors.contains_key("a"));
        }
    }
}
