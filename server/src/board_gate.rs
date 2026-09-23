//! Browser and provider hooks share the same completion decision.
use std::path::Path;

pub async fn human_drag_denial(project: &Path, id: &str, status: &str) -> Option<String> {
    let project = project.to_path_buf();
    let id = id.to_owned();
    let status = status.to_owned();
    match tokio::task::spawn_blocking(move || {
        crate::board_landing::transition(&project, &id, &status, true)
    })
    .await
    {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error),
        Err(error) => Some(format!("Cannot verify board transition: {error}")),
    }
}
