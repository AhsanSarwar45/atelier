//! Atelier — the server.
//!
//! An Axum-based HTTP server that serves the screens and answers the API
//! behind them. The one name the product answers to lives in `identity.rs`.

mod command_line;
mod db;
mod doing;
mod dolt;
mod handover;
mod helper;
mod identity;
mod laid_down;
mod reachable;
mod report_tools;
mod routes;
mod rules;
mod serving;
mod service;

use axum::{
    body::Body,
    extract::Extension,
    http::{header, Request, Response, StatusCode},
    response::IntoResponse,
    routing::{delete, get, patch, post, put},
    Router,
};
use rust_embed::{Embed, EmbeddedFile};
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

/// Embedded static files from the Next.js build output.
#[derive(Embed)]
#[folder = "../out/"]
struct Assets;

fn env_flag(name: &str) -> bool {
    env::var(name)
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

/// Serves embedded static files, with fallback to index.html for SPA routing.
///
/// Every answer says how long it may be kept and what it is, so a browser
/// holding the previous build is told to come and get the new one rather than
/// drawing what it already has (bw-8um.3.11).
async fn serve_static(req: Request<Body>) -> impl IntoResponse {
    let path = req.uri().path().trim_start_matches('/').to_string();
    let held = req
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|offered| offered.to_str().ok())
        .map(str::to_owned);
    let held = held.as_deref();

    // Try the exact path first
    if let Some(content) = Assets::get(&path) {
        let mime = mime_guess::from_path(&path).first_or_octet_stream();
        return served(&path, content, mime.as_ref(), held);
    }

    // Try with .html extension (for Next.js static export)
    let html_path = format!("{}.html", path);
    if let Some(content) = Assets::get(&html_path) {
        return served(&html_path, content, "text/html", held);
    }

    // Try index.html in subdirectory
    let index_path = if path.is_empty() {
        "index.html".to_string()
    } else {
        format!("{}/index.html", path)
    };
    if let Some(content) = Assets::get(&index_path) {
        return served(&index_path, content, "text/html", held);
    }

    // Fallback to root index.html for SPA client-side routing
    if let Some(content) = Assets::get("index.html") {
        return served("index.html", content, "text/html", held);
    }

    // 404 if nothing found
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from("Not Found"))
        .unwrap()
}

/// One embedded file, answered the same way whichever of the four routes above
/// found it — which is what stops a rule being added to three of them.
fn served(path: &str, file: EmbeddedFile, mime: &str, held: Option<&str>) -> Response<Body> {
    let tag = serving::tag_for(&file.metadata.sha256_hash());
    let kept_for = serving::kept_for(path);

    // The browser already has this exact file. Saying so costs a few bytes
    // instead of the whole file, which is what makes asking every time cheap.
    if serving::already_held(held, &tag) {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::CACHE_CONTROL, kept_for)
            .header(header::ETAG, &tag)
            .body(Body::empty())
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, kept_for)
        .header(header::ETAG, &tag)
        .body(Body::from(file.data.into_owned()))
        .unwrap()
}

#[tokio::main]
async fn main() {
    // An install made under the earlier name is carried across before anything
    // reads the settings, so a person who upgrades finds their projects where
    // they left them rather than an empty list (bw-8um.3.8).
    if let Err(e) = identity::adopt_earlier_install() {
        eprintln!("the earlier install could not be carried over: {e}");
    }

    match command_line::asked(env::args().skip(1)) {
        command_line::Ask::Run { open_browser } => serve(open_browser).await,
        command_line::Ask::Help => print!("{}", command_line::help()),
        // Having the computer start it is one command, and taking that back
        // off is one command, so nobody edits a service file by hand
        // (bw-8um.3.13).
        command_line::Ask::Service(action) => {
            if let Err(e) = service::run(action) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        // The third of the three commands a teammate types. Installing gets
        // them the program, `service install` has the computer keep it up, and
        // this one turns a folder they already have into a project it runs
        // (bw-8um.3.6).
        command_line::Ask::Init(rest) => match rules::init(&rest) {
            Ok(code) => std::process::exit(code),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        },
        // Not typed by a person. A joined project's settings name this, so the
        // gates it runs are a word rather than one machine's folder.
        command_line::Ask::Hook { name, rest } => match rules::hook(&name, &rest) {
            Ok(code) => std::process::exit(code),
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        },
        command_line::Ask::Version => println!("{}", command_line::version()),
        // A copy the computer started at login printed its addresses into a
        // log nobody reads. Asking it where it is has to be something a person
        // can type, and it must not bring a second server up to answer
        // (bw-sxdg.1).
        command_line::Ask::Where => print!("{}", whereabouts()),
        // Where this computer keeps this program's data, printed and nothing
        // else. The report command runs from a shell and needs the same answer
        // this program uses; asking the program is what stops it working the
        // three per-platform paths out a second time in bash (bw-pqt.24).
        command_line::Ask::DataDir => match identity::data_dir() {
            Some(dir) => println!("{}", dir.display()),
            None => {
                eprintln!("this computer names no folder for a program's data");
                std::process::exit(1);
            }
        },
        // It used to start the server for anything it did not recognise, so a
        // mistyped flag looked like it had been taken and quietly wasn't.
        command_line::Ask::Unknown(word) => {
            eprintln!("{}: `{word}` is not something it does.\n", identity::NAME);
            eprint!("{}", command_line::help());
            std::process::exit(2);
        }
    }
}

/// Who may reach it, as the environment was left.
fn bind_host() -> String {
    env::var("ATELIER_HOST")
        .or_else(|_| env::var("BEADS_WEB_HOST"))
        .or_else(|_| env::var("HOST"))
        .unwrap_or_else(|_| "0.0.0.0".to_string())
}

/// The port it listens on, as the environment was left.
fn bind_port() -> u16 {
    env::var("ATELIER_PORT")
        .or_else(|_| env::var("BEADS_WEB_PORT"))
        .or_else(|_| env::var("PORT"))
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(command_line::PORT)
}

/// Where it can be opened, and whether anything is there.
///
/// The same lines the running copy prints, worked out the same way from the
/// same settings — because the copy that printed them may have been started by
/// the computer itself, hours ago, into a log the reader never sees. Nothing
/// is started to answer this.
fn whereabouts() -> String {
    let port = bind_port();
    let network = reachable::on_this_network();
    let name = reachable::name_on_this_network(network);
    let mut said = format!("{} — where to open it.\n", identity::DISPLAY);
    for line in reachable::openable_at(&bind_host(), port, network, name.as_deref()) {
        said.push_str(&format!("  {line}\n"));
    }
    said.push_str(if answering(port) {
        "It is answering there now.\n"
    } else {
        "Nothing is answering on that port. Start it with `atelier run`.\n"
    });
    said
}

/// Whether something already holds the port this would use.
fn answering(port: u16) -> bool {
    let here = SocketAddr::from(([127, 0, 0, 1], port));
    std::net::TcpStream::connect_timeout(&here, Duration::from_millis(400)).is_ok()
}

/// Bring the whole product up.
///
/// The server, the screens it serves and the chat helper behind them, in one
/// process tree. There is no second thing to start: the screens are embedded
/// in this binary and the helper is a child of this process, which is what
/// makes `atelier run` the whole of it (bw-8um.3.12).
async fn serve(open_browser: bool) {
    // Initialize tracing subscriber for logging
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();
    tracing::subscriber::set_global_default(subscriber)
        .expect("Failed to set tracing subscriber");

    // Where it listens, read the one way `atelier where` reads it too.
    let host = bind_host();
    let port = bind_port();

    // The door is taken first, before a line of the rest of it runs.
    //
    // It used to be taken last. A reader whose computer was already serving
    // watched five healthy lines go by — the database, the report tools, the
    // tracker, the chat helper laid down and its sidecar started — and then
    // the program died on a bind error with a debugger hint, having started a
    // helper it then abandoned. Nothing it had said was untrue and none of it
    // was the point (bw-8um.3.10.2).
    let addr = format!("{}:{}", host, port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(listener) => listener,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            let network = reachable::on_this_network();
            let name = reachable::name_on_this_network(network);
            let openable = reachable::openable_at(&host, port, network, name.as_deref());
            let who = handover::who_is_there(port).await;
            let ours = handover::program().map(|p| p.display().to_string());
            let (said, code) =
                handover::already_serving(who.as_ref(), ours.as_deref(), port, &openable);
            print!("{said}");
            std::process::exit(code);
        }
        Err(e) => {
            eprintln!("{} could not listen on {addr}: {e}", identity::DISPLAY);
            std::process::exit(1);
        }
    };

    // Which copy this is, worked out once here rather than on the first
    // request: reading the program's own bytes is the only honest way to tell
    // two builds of one version apart, and nobody should wait on it.
    let ours = handover::program().map(|p| p.display().to_string());
    info!(
        "{} {} (build {})",
        identity::DISPLAY,
        env!("CARGO_PKG_VERSION"),
        handover::fingerprint()
    );
    let _ = handover::started_at();

    // A registration names one exact file and nothing that installs a program
    // afterwards knows it exists, so the copy this computer starts at login
    // can quietly be one nobody has updated in months. Saying so is the whole
    // of the fix — the reader can then point it at this one (bw-8um.3.10.4).
    let registered = service::registered_program();
    if let Some(note) = handover::a_different_copy(registered.as_deref(), ours.as_deref()) {
        print!("{note}");
    }

    // And from here on, an install of a newer build over that same program
    // takes over by itself: this copy stands down and the computer starts
    // whatever replaced it (bw-8um.3.10.1).
    if let Some(registered) = registered {
        handover::stand_down_for_a_newer_build(std::path::PathBuf::from(registered));
    }

    // Configure CORS for development
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // Initialize the database
    let database = Arc::new(
        db::Database::new().expect("Failed to initialize database"),
    );
    info!("Database initialized");

    // The tools that make a report travel inside the product; this lays them
    // down beside the reports. A copy that cannot write there still serves the
    // board, so this warns rather than stopping.
    match report_tools::install() {
        Ok(()) => info!("Report tools ready"),
        Err(e) => tracing::warn!("Report tools not laid down, so no report can be made: {}", e),
    }

    // Initialize Dolt connection manager
    let dolt_manager = Arc::new(dolt::DoltManager::new());
    if dolt_manager.check_server().await {
        info!("Dolt server is available on port 3307");
    } else {
        info!("Dolt server not detected — will use bd CLI / JSONL fallback");
    }

    // Check for bd CLI availability and compatibility
    if let Some(bd) = routes::find_bd() {
        info!("bd CLI found: {}", bd.display());
        if let Ok(output) = std::process::Command::new(bd).arg("--version").output() {
            if output.status.success() {
                let version = String::from_utf8_lossy(&output.stdout);
                info!("bd version: {}", version.trim());
            }
        }
        // Verify --json flag works (older bd versions output plain text)
        let test_dir = std::env::temp_dir();
        if let Ok(output) = std::process::Command::new(bd)
            .args(["list", "--json", "--limit", "1"])
            .current_dir(&test_dir)
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let trimmed = stdout.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('[') {
                tracing::warn!("⚠ bd CLI does not support --json output");
                tracing::warn!("  Beads will not load for filesystem projects");
                tracing::warn!("  Please update: npm install -g beads");
            }
        }
    } else {
        tracing::warn!("⚠ bd CLI not found — beads read/write will not work for filesystem projects");
        tracing::warn!("  Install: https://github.com/gastownhall/beads");
    }

    // Initialize version check cache
    let version_cache = routes::version::new_cache();

    // The chat helper travels inside the product too, and is written out
    // beside the data. Before this it was started from the checkout it was
    // BUILT in, so on anybody else's computer the Chat tab had nothing behind
    // it (bw-8um.3.9). A copy that cannot write there still serves the board.
    let helper = match helper::install() {
        Ok(laid) => {
            info!("Chat helper ready at {}", laid.entry.display());
            Some(laid)
        }
        Err(e) => {
            tracing::warn!("The chat helper was not laid down, so the Chat tab will not answer: {}", e);
            None
        }
    };

    routes::workbench::spawn_sidecar(helper);

    // The first read of a board costs a `bd` run, and the reader used to pay
    // it on whichever board they opened first. It is paid here instead, with
    // nobody waiting (bw-uiyz.18).
    routes::beads::read_boards_ahead(dolt_manager.clone(), database.clone());

    // Build the router
    let app = Router::new()
        .route("/api/health", get(routes::health))
        .nest("/api", routes::project_routes().with_state(database.clone()))
        .route("/api/beads", get(routes::beads::read_beads))
        .route("/api/beads/create", post(routes::beads::create_bead_handler))
        .route("/api/beads/update", patch(routes::beads::update_bead_handler))
        // Dolt endpoints
        .route("/api/dolt/status", get(routes::dolt::dolt_status))
        .route("/api/dolt/databases", get(routes::dolt::dolt_databases))
        .route("/api/dolt/servers", get(routes::dolt::dolt_servers))
        .route("/api/fs/list", get(routes::fs::list_directory))
        .route("/api/fs/exists", get(routes::fs::path_exists))
        .route("/api/fs/roots", get(routes::fs::fs_roots))
        .route("/api/fs/open-external", post(routes::fs::open_external))
        .route("/api/bd/command", post(routes::cli::bd_command))
        .nest("/api", routes::reports::router().with_state(database.clone()))
        .route("/api/git/branch-status", get(routes::git::branch_status))
        // Worktree endpoints
        .route("/api/git/worktree-status", get(routes::worktree::worktree_status))
        .route("/api/git/worktree", post(routes::worktree::create_worktree))
        .route("/api/git/worktree", delete(routes::worktree::delete_worktree))
        .route("/api/git/worktrees", get(routes::worktree::list_worktrees))
        // PR endpoints
        // Agent endpoints
        .route("/api/agents", get(routes::agents::list_agents))
        .route("/api/agents/:filename", put(routes::agents::update_agent))
        // Memory endpoints
        .route(
            "/api/memory",
            get(routes::memory::list_memory)
                .put(routes::memory::update_memory)
                .delete(routes::memory::delete_memory),
        )
        .route("/api/watch/beads", get(routes::watch_beads))
        .nest("/api/workbench", routes::workbench::router())
        .route("/api/version/check", get(routes::version::version_check))
        .route("/api/update", post(routes::version::perform_update))
        .fallback(serve_static)
        .layer(Extension(version_cache))
        .layer(Extension(database))
        .layer(Extension(dolt_manager))
        .layer(cors);

    // Where it bound, not an address to open: `http://0.0.0.0:3008` is not
    // something a browser can be pointed at, and offering it beside the two
    // that work is what leaves a reader typing the wrong one (bw-hkai.1).
    info!("{} is listening on {}", identity::DISPLAY, addr);

    // One command, and the reader is looking at the board — not reading a port
    // number out of a log line and typing it into a browser themselves. Both
    // addresses, because the one a phone needs is not the one this computer
    // needs, and it has always answered on both without saying so (bw-hkai.1).
    // The name goes ahead of the number, because the number is a lease the
    // router can take back and the name is not (bw-sxdg.1).
    println!("{} is running.", identity::DISPLAY);
    let network = reachable::on_this_network();
    let name = reachable::name_on_this_network(network);
    for line in reachable::openable_at(&host, port, network, name.as_deref()) {
        println!("  {line}");
    }
    println!("The screens and the chat are inside this program; there is nothing else to start.");

    // What a chat says it is doing only reaches the screen if the session is
    // told to say it, and being told is one line in a settings file nobody
    // should have to know about. So the first run writes it, and says so once
    // (bw-14ij.1). A copy that cannot write there still serves the board.
    match doing::wire_up() {
        Ok((done, settings)) => {
            if let Some(line) = doing::said_it(&done, &settings) {
                println!("{line}");
            }
        }
        Err(e) => tracing::warn!("Your chats were not wired up to say what they are doing: {}", e),
    }

    if open_browser || env_flag("ATELIER_OPEN_BROWSER") || env_flag("BEADS_WEB_OPEN_BROWSER") {
        if let Err(e) = open::that(format!("http://localhost:{}", port)) {
            tracing::warn!("Failed to open browser: {}", e);
        }
    }

    // Start the server
    axum::serve(listener, app)
        .await
        .expect("Server failed to start");
}
