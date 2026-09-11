//! Per-provider account profiles.
//!
//! A provider CLI keeps its whole identity in one directory: Claude reads
//! `CLAUDE_CONFIG_DIR`, Codex reads `CODEX_HOME`, and the token that says who
//! you are lives under it. Pointing a spawned CLI at a different directory is
//! therefore the whole of switching account, and two directories mean two
//! accounts signed in at the same time rather than one person logging out and
//! back in between a work chat and a personal one.
//!
//! A profile belongs to exactly one brand. Somebody with two Claude accounts
//! and one Codex account should not have to invent a pairing between them, so
//! there is no profile that spans providers.
//!
//! Every brand also has a *system* profile, which is not stored here: it is
//! whatever directory the server itself resolved at boot, normally `~/.claude`
//! and `~/.codex`. That is the account the owner already signed into from a
//! terminal, so a fresh install has a working profile without being asked to
//! create one.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::provider_defaults::atomic_write;

/// The id of the profile backed by the directory the server booted with.
pub const SYSTEM: &str = "system";

/// The brands whose CLI keeps its account in a relocatable directory. The
/// local brand runs no hosted account, so it has no profiles at all.
const BRANDS: &[(&str, &str)] = &[("claude", "CLAUDE_CONFIG_DIR"), ("codex", "CODEX_HOME")];

/// The environment variable a brand reads its config directory from, or `None`
/// for a brand that has no account to switch.
pub fn variable(brand: &str) -> Option<&'static str> {
    BRANDS
        .iter()
        .find(|(name, _)| *name == brand)
        .map(|(_, variable)| *variable)
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub brand: String,
    pub name: String,
    /// True for the boot-time directory, which cannot be renamed or deleted
    /// because the app does not own it.
    pub system: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct Index {
    #[serde(default)]
    profiles: Vec<Stored>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    brand: String,
    name: String,
}

/// The registry of account profiles and the directories behind them.
#[derive(Clone, Debug)]
pub struct Profiles {
    root: PathBuf,
    system: BTreeMap<String, PathBuf>,
}

impl Profiles {
    /// `root` is where created profiles live; the two configured paths are the
    /// system profile for their brand.
    pub fn new(root: PathBuf, claude_config: PathBuf, codex_home: PathBuf) -> Self {
        Self {
            root,
            system: BTreeMap::from([
                ("claude".to_string(), claude_config),
                ("codex".to_string(), codex_home),
            ]),
        }
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("profiles.json")
    }

    fn read_index(&self) -> Index {
        // A missing or unreadable index means no profiles have been created,
        // not a dead app: the system profile still works, so answer with it
        // rather than refusing every list.
        fs::read(self.index_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write_index(&self, index: &Index) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(index).map_err(|error| error.to_string())?;
        atomic_write(&self.index_path(), &bytes)
    }

    fn system_profile(&self, brand: &str) -> Option<Profile> {
        self.system.contains_key(brand).then(|| Profile {
            id: SYSTEM.to_string(),
            brand: brand.to_string(),
            name: "System".to_string(),
            system: true,
        })
    }

    /// Every profile for one brand, the system profile first. A brand with no
    /// relocatable account answers with nothing, which is what hides the
    /// profile picker for it.
    pub fn list(&self, brand: &str) -> Vec<Profile> {
        let Some(system) = self.system_profile(brand) else {
            return Vec::new();
        };
        let mut profiles = vec![system];
        profiles.extend(self.read_index().profiles.into_iter().filter_map(|stored| {
            (stored.brand == brand).then(|| Profile {
                id: stored.id,
                brand: stored.brand,
                name: stored.name,
                system: false,
            })
        }));
        profiles
    }

    /// The directory a chat on this profile must point its CLI at.
    pub fn directory(&self, brand: &str, id: &str) -> Result<PathBuf, String> {
        if id == SYSTEM {
            return self
                .system
                .get(brand)
                .cloned()
                .ok_or_else(|| format!("{brand} has no account directory"));
        }
        let known = self
            .read_index()
            .profiles
            .into_iter()
            .any(|stored| stored.id == id && stored.brand == brand);
        if !known {
            return Err(format!("no {brand} profile {id}"));
        }
        Ok(self.directory_for(brand, id))
    }

    fn directory_for(&self, brand: &str, id: &str) -> PathBuf {
        self.root.join(brand).join(id)
    }

    /// Create an empty profile and the directory that will hold its login.
    ///
    /// The directory is made here rather than at first sign-in so that the
    /// login command has somewhere to write, and so a profile that has not
    /// been signed into yet is still a real thing the picker can show.
    pub fn create(&self, brand: &str, name: &str) -> Result<Profile, String> {
        if variable(brand).is_none() {
            return Err(format!("{brand} has no account to switch"));
        }
        let name = name.trim();
        if name.is_empty() {
            return Err("a profile needs a name".to_string());
        }
        let mut index = self.read_index();
        if index
            .profiles
            .iter()
            .any(|stored| stored.brand == brand && stored.name.eq_ignore_ascii_case(name))
        {
            return Err(format!("there is already a {brand} profile called {name}"));
        }
        let id = self.unique_id(&index, brand, name);
        let directory = self.directory_for(brand, &id);
        create_private_dir(&directory)?;
        index.profiles.push(Stored {
            id: id.clone(),
            brand: brand.to_string(),
            name: name.to_string(),
        });
        self.write_index(&index)?;
        Ok(Profile {
            id,
            brand: brand.to_string(),
            name: name.to_string(),
            system: false,
        })
    }

    /// A readable directory name, because the whole point of a profile is that
    /// somebody can also point the CLI at it by hand from a terminal.
    fn unique_id(&self, index: &Index, brand: &str, name: &str) -> String {
        let base = slug(name);
        let taken = |candidate: &str| {
            index
                .profiles
                .iter()
                .any(|stored| stored.brand == brand && stored.id == candidate)
                || self.directory_for(brand, candidate).exists()
        };
        if !taken(&base) {
            return base;
        }
        (2..)
            .map(|suffix| format!("{base}-{suffix}"))
            .find(|candidate| !taken(candidate))
            .expect("an unused suffix always exists")
    }

    pub fn rename(&self, brand: &str, id: &str, name: &str) -> Result<Profile, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a profile needs a name".to_string());
        }
        if id == SYSTEM {
            return Err("the system profile cannot be renamed".to_string());
        }
        let mut index = self.read_index();
        if index.profiles.iter().any(|stored| {
            stored.brand == brand && stored.id != id && stored.name.eq_ignore_ascii_case(name)
        }) {
            return Err(format!("there is already a {brand} profile called {name}"));
        }
        let stored = index
            .profiles
            .iter_mut()
            .find(|stored| stored.brand == brand && stored.id == id)
            .ok_or_else(|| format!("no {brand} profile {id}"))?;
        // The id and its directory stay put: renaming must not move a signed-in
        // account out from under a chat that is already running on it.
        stored.name = name.to_string();
        let renamed = Profile {
            id: id.to_string(),
            brand: brand.to_string(),
            name: name.to_string(),
            system: false,
        };
        self.write_index(&index)?;
        Ok(renamed)
    }

    /// Forget a profile and remove the credentials it was holding.
    pub fn delete(&self, brand: &str, id: &str) -> Result<(), String> {
        if id == SYSTEM {
            return Err("the system profile cannot be deleted".to_string());
        }
        let mut index = self.read_index();
        let before = index.profiles.len();
        index
            .profiles
            .retain(|stored| !(stored.brand == brand && stored.id == id));
        if index.profiles.len() == before {
            return Err(format!("no {brand} profile {id}"));
        }
        self.write_index(&index)?;
        // Drop the index entry first. A directory left behind is invisible and
        // harmless; an entry pointing at a directory that is already gone would
        // send a chat to an account that cannot sign in.
        let directory = self.directory_for(brand, id);
        if directory.exists() {
            fs::remove_dir_all(&directory).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn slug(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let mut tidy = String::with_capacity(replaced.len());
    let mut previous_dash = false;
    for character in replaced.trim_matches('-').chars() {
        if character == '-' && previous_dash {
            continue;
        }
        previous_dash = character == '-';
        tidy.push(character);
    }
    if tidy.is_empty() {
        "profile".to_string()
    } else {
        tidy
    }
}

/// A profile directory holds an OAuth token, so it is the owner's to read.
fn create_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profiles(root: &Path) -> Profiles {
        Profiles::new(
            root.join("profiles"),
            root.join("system-claude"),
            root.join("system-codex"),
        )
    }

    #[test]
    fn a_brand_starts_with_only_its_system_profile() {
        let root = tempfile::tempdir().unwrap();
        let profiles = profiles(root.path());
        for brand in ["claude", "codex"] {
            let listed = profiles.list(brand);
            assert_eq!(listed.len(), 1, "{brand}");
            assert_eq!(listed[0].id, SYSTEM);
            assert!(listed[0].system);
        }
    }

    #[test]
    fn a_brand_with_no_hosted_account_has_no_profiles() {
        let root = tempfile::tempdir().unwrap();
        assert!(profiles(root.path()).list("local").is_empty());
        assert!(variable("local").is_none());
        assert!(profiles(root.path()).create("local", "Work").is_err());
    }

    #[test]
    fn creating_makes_a_private_directory_and_lists_it() {
        let root = tempfile::tempdir().unwrap();
        let profiles = profiles(root.path());
        for brand in ["claude", "codex"] {
            let made = profiles.create(brand, "Work").unwrap();
            assert_eq!(made.id, "work");
            assert!(!made.system);

            let directory = profiles.directory(brand, &made.id).unwrap();
            assert!(directory.is_dir());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&directory).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o700, "{brand}");
            }

            let listed = profiles.list(brand);
            assert_eq!(listed.len(), 2, "{brand}");
            assert_eq!(listed[0].id, SYSTEM, "system profile comes first");
            assert_eq!(listed[1], made);
        }
    }

    #[test]
    fn a_profile_is_private_to_its_brand() {
        let root = tempfile::tempdir().unwrap();
        let profiles = profiles(root.path());
        profiles.create("claude", "Work").unwrap();
        assert_eq!(profiles.list("codex").len(), 1);
        assert!(profiles.directory("codex", "work").is_err());
    }

    #[test]
    fn the_system_profile_is_the_directory_the_server_booted_with() {
        let root = tempfile::tempdir().unwrap();
        let profiles = profiles(root.path());
        assert_eq!(
            profiles.directory("claude", SYSTEM).unwrap(),
            root.path().join("system-claude")
        );
        assert_eq!(
            profiles.directory("codex", SYSTEM).unwrap(),
            root.path().join("system-codex")
        );
    }

    #[test]
    fn two_profiles_with_one_name_are_refused_but_similar_names_get_their_own_directory() {
        let root = tempfile::tempdir().unwrap();
        let profiles = profiles(root.path());
        profiles.create("claude", "Work").unwrap();
        assert!(profiles.create("claude", "work").is_err());
        assert_eq!(profiles.create("claude", "Work!").unwrap().id, "work-2");
    }

    #[test]
    fn renaming_keeps_the_directory_so_a_running_chat_keeps_its_account() {
        let root = tempfile::tempdir().unwrap();
        let profiles = profiles(root.path());
        let made = profiles.create("claude", "Work").unwrap();
        let before = profiles.directory("claude", &made.id).unwrap();

        let renamed = profiles.rename("claude", &made.id, "Day job").unwrap();
        assert_eq!(renamed.name, "Day job");
        assert_eq!(renamed.id, made.id);
        assert_eq!(profiles.directory("claude", &made.id).unwrap(), before);
        assert_eq!(profiles.list("claude")[1].name, "Day job");
    }

    #[test]
    fn deleting_forgets_the_profile_and_its_credentials() {
        let root = tempfile::tempdir().unwrap();
        let profiles = profiles(root.path());
        let made = profiles.create("codex", "Personal").unwrap();
        let directory = profiles.directory("codex", &made.id).unwrap();
        fs::write(directory.join("auth.json"), b"{}").unwrap();

        profiles.delete("codex", &made.id).unwrap();
        assert!(!directory.exists());
        assert_eq!(profiles.list("codex").len(), 1);
        assert!(profiles.directory("codex", &made.id).is_err());
    }

    #[test]
    fn the_system_profile_cannot_be_renamed_or_deleted() {
        let root = tempfile::tempdir().unwrap();
        let profiles = profiles(root.path());
        assert!(profiles.rename("claude", SYSTEM, "Mine").is_err());
        assert!(profiles.delete("claude", SYSTEM).is_err());
        assert_eq!(profiles.list("claude").len(), 1);
    }

    #[test]
    fn profiles_survive_a_restart() {
        let root = tempfile::tempdir().unwrap();
        let made = profiles(root.path()).create("claude", "Work").unwrap();
        let reopened = profiles(root.path());
        assert_eq!(reopened.list("claude")[1], made);
        assert!(reopened.directory("claude", &made.id).unwrap().is_dir());
    }
}
