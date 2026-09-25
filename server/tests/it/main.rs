//! Every integration test, in one test program.
//!
//! Each file here was once its own program, and each program carried a whole
//! copy of the server and its dependencies. Linking seventeen of them at once
//! took more memory than a chat is allowed, so they are modules of one program
//! now, linked once.
//!
//! One area runs on its own by naming its module:
//!
//!   cargo test --test it skill_folders::
//!
//! A new integration test is a new module here, never a new file beside
//! `it/`: Cargo turns every file directly under `tests/` into a program of
//! its own.

mod a_push_reaches_a_real_device;
mod a_session_event_reaches_the_file_on_disk;
mod a_start_leaves_the_readers_own_settings_alone;
mod build_hygiene;
mod carried_folders_reach_the_build;
mod hook_identity;
mod legacy_database_clone;
mod native_machinery;
mod no_node_runtime;
mod one_version_for_the_whole_product;
mod skill_folders;
mod skill_locations;
mod shared_memory_tool;
mod the_git_panel_speaks_to_real_git;
mod the_install_recipe_takes_over_nothing;
mod the_presenter_and_the_reader_agree;
