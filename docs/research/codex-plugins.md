# Codex CLI plugins (and Claude Code synced plugins) — research

Date: 2026-09-23. Researched for reusing the app's Claude plugin UI with Codex.

## Sources and versions

- Latest stable Codex release: `rust-v0.156.1` (published 2026-09-23T02:41Z, `gh release list -R openai/codex`).
  Source cited below is that tag, commit `b412ff32c417f855c2b2d1581b77058eed87c84b`.
  Link base: `https://github.com/openai/codex/blob/rust-v0.156.1/` (written below as `codex:`).
- Installed locally: `codex-cli 0.153.4` (`codex --version`). The plugin CLI surface is the same in both
  (compare local `codex plugin --help` with `codex:codex-rs/cli/src/plugin_cmd.rs#L60-L78`).
- Docs: `https://developers.openai.com/codex/plugins` (now 308-redirects to `https://learn.chatgpt.com/docs/plugins`),
  `https://developers.openai.com/plugins/build/plugins`.
- Claude Code docs: `https://code.claude.com/docs/en/plugins-reference`.
- Note: `codex-rs/app-server/README.md` at this tag does not document the plugin RPCs (only thread plugin
  settings, L256-L268). The protocol source is the only authoritative reference for request shapes.

---

## 1. Plugin system and what a plugin is

Yes, Codex has a plugin system. It is behind feature flag `plugins` ("Enable plugins",
`codex:codex-rs/features/src/lib.rs#L242-L243`, key at L1433-L1434). The remote catalog is flag
`remote_plugin` (L286-L287) and sharing is `plugin_sharing` (L288-L289). Locally
`codex features list` shows `plugins stable true`, `remote_plugin stable true`, `plugin_sharing stable true`.

### Manifest location

A plugin root is found by any of these manifest paths, in order
(`codex:codex-rs/exec-server-protocol/src/protocol.rs#L49-L53`):

1. `.codex-plugin/plugin.json` (native)
2. `.claude-plugin/plugin.json` (Claude Code compatible)
3. `.cursor-plugin/plugin.json`

A fourth format, the portable "Agent Plugins" manifest, is a root-level `plugin.json`
(`AGENT_PLUGIN_MANIFEST_RELATIVE_PATH = "plugin.json"`, `codex:codex-rs/utils/plugins/src/plugin_namespace.rs#L12`)
that must declare `$schema` = `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` (same file L15-L17;
check in `codex:codex-rs/core-plugins/src/agent_plugin_manifest.rs#L141`). The public build docs now describe
this portable format, with OpenAI-specific settings under `"extensions": { "com.openai": { ... } }`
(`https://developers.openai.com/plugins/build/plugins`).

### Manifest fields (`.codex-plugin/plugin.json`)

From `RawPluginManifest` (`codex:codex-rs/core-plugins/src/manifest.rs#L44-L70`), camelCase:

| Field | Type |
|---|---|
| `name` | string |
| `version` | string, optional (cache dir falls back to `local`, `codex:codex-rs/core-plugins/src/store.rs#L25`) |
| `description` | string |
| `keywords` | string[] |
| `skills` | `"./path"` or `["./a", "./b"]` |
| `mcpServers` | `"./path.json"` or inline object |
| `apps` | `"./.app.json"` path |
| `hooks` | path, paths, inline hooks object, or list of inline objects |
| `interface` | object, see below |
| `extensions` | free JSON |

`interface` (`manifest.rs#L78-L114`): `displayName`, `shortDescription`, `longDescription`, `developerName`,
`category`, `capabilities[]`, `websiteUrl`/`websiteURL`, `privacyPolicyUrl`/`privacyPolicyURL`,
`termsOfServiceUrl`/`termsOfServiceURL`, `defaultPrompt` (max 3 entries of 128 chars, L13-L14),
`brandColor`, `composerIcon`, `logo`, `logoDark`, `screenshots[]`. Paths must use `./...` syntax
(comment at L56-L57).

Real example on disk: `~/.codex/plugins/cache/openai-curated-remote/openai-templates/0.1.1/.codex-plugin/plugin.json`
(fields `name, version, description, author, homepage, repository, license, keywords, skills: "./skills/",
apps: "./.app.json", interface{...}`). `author`/`homepage`/`repository`/`license` are present in real
manifests but are not read by `RawPluginManifest` (ignored by serde).

### What a plugin can bundle

Default component locations when the manifest does not declare them
(`codex:codex-rs/core-plugins/src/loader.rs#L67-L70`):

- `skills/` — skills (`SKILL.md` folders)
- `.mcp.json` — MCP servers
- `.app.json` — apps (ChatGPT connectors), e.g. `{"apps":{"default_templates":{"id":"connector_...","required":true}}}`
  (local file `~/.codex/plugins/cache/openai-curated-remote/openai-templates/0.1.1/.app.json`)
- `hooks/hooks.json` — lifecycle hooks

The curated repo README also lists plugin-level `agents/`, `commands/`, `assets/`
(`~/.codex/.tmp/plugins/README.md`, a checkout of `https://github.com/openai/plugins`). `commands` is parsed by
`RawPluginCommandManifest` (`manifest.rs#L72-L76`, `command_migration.rs`).
The app-server `PluginDetail` exposes `skills`, `hooks`, `apps`, `appTemplates`, `mcpServers`,
`scheduledTasks`, `onboardingSkill` (`codex:codex-rs/app-server-protocol/src/protocol/v2/plugin.rs#L757-L775`).

Per-plugin MCP policy can be overlaid in config: `[plugins."id".mcp_servers.<server>]` with `enabled`,
`default_tools_approval_mode`, `enabled_tools`, `disabled_tools`, `tools`, `ema_auth`
(`codex:codex-rs/config/src/types.rs#L934-L975`).

---

## 2. Marketplaces

### marketplace.json location

A marketplace root is recognised by any of these files (`codex:codex-rs/core-plugins/src/marketplace.rs#L20-L25`):

- `.agents/plugins/marketplace.json` (native)
- `.agents/plugins/api_marketplace.json`
- `.claude-plugin/marketplace.json` (Claude Code compatible)
- `.cursor-plugin/marketplace.json`

Discovery roots (`marketplace.rs#L450-L488`, `manager.rs#L3540-L3575`):

1. Personal: `$HOME/.agents/plugins/marketplace.json`. This uses `HOME`/`USERPROFILE`, NOT `CODEX_HOME`
   (`marketplace.rs#L303-L311`). Docs agree: "Personal marketplace: `~/.agents/plugins/marketplace.json`"
   (`https://developers.openai.com/plugins/build/plugins`).
2. Repo: for each `cwd` passed in, the root itself or its git repo root (`$REPO_ROOT/.agents/plugins/marketplace.json`).
3. Added marketplaces from `[marketplaces.*]` in config (below).
4. The OpenAI curated marketplace checkout at `$CODEX_HOME/.tmp/plugins`.

### marketplace.json format

`RawMarketplaceManifest` (`marketplace.rs#L970-L1043`):

```json
{
  "name": "openai-curated",
  "interface": { "displayName": "Codex official" },
  "plugins": [
    {
      "name": "linear",
      "source": { "source": "local", "path": "./plugins/linear" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL", "products": ["..."] },
      "category": "Productivity"
    }
  ]
}
```

(Example copied from local `~/.codex/.tmp/plugins/.agents/plugins/marketplace.json`, 120 plugins.)

- `source` may be a bare string path, or an object tagged by `source`: `local {path}`,
  `url {url, path?, ref?, sha?}`, `git-subdir {url, path, ref?, sha?}`, `npm {package, version?, registry?}`
  (`marketplace.rs#L1008-L1043`).
- `policy.installation`: `NOT_AVAILABLE | AVAILABLE | INSTALLED_BY_DEFAULT`;
  `policy.authentication`: `ON_INSTALL | ON_USE` (`marketplace.rs#L166-L184`).
- Extra per-plugin fields are kept as `manifest_fields` and used as a manifest fallback (`#L996`).

### Adding / removing marketplaces

CLI (local `codex plugin marketplace --help`; `codex:codex-rs/cli/src/plugin_cmd.rs`):

```
codex plugin marketplace add <SOURCE> [--ref REF] [--sparse PATH]... [--json]
    SOURCE = local path | owner/repo[@ref] | HTTPS Git URL | SSH Git URL
codex plugin marketplace list [--json]
codex plugin marketplace upgrade [MARKETPLACE_NAME] [--json]   # refresh Git snapshots; all if omitted
codex plugin marketplace remove <MARKETPLACE_NAME> [--json]
```

Effect on disk:

- Config entry `[marketplaces.<name>]` in `$CODEX_HOME/config.toml` with keys `source_type` (`git`|`local`),
  `source`, `ref`, `sparse_paths`, `last_updated`, `last_revision`
  (`codex:codex-rs/config/src/types.rs#L1032-L1057`; writer `codex:codex-rs/config/src/marketplace_edit.rs#L27-L60`,
  test at L184-L216). The marketplace name comes from the `name` field of its marketplace.json
  (test `marketplace_add.rs#L239-L273`: adding a repo whose manifest says `debug` yields `[marketplaces.debug]`).
- Git marketplaces are cloned to `$CODEX_HOME/.tmp/marketplaces/<name>`; local ones are used in place
  (`codex:codex-rs/core-plugins/src/installed_marketplaces.rs#L12-L16`, `#L65-L78`).
- Admins can restrict sources with `[marketplaces.allowed_sources.*]` requirements (test `marketplace_add.rs#L284`,
  `config_requirements.rs#L190`).

### Official marketplaces

Two built-ins:

1. `openai-curated` (display "Codex official"): Git repo `https://github.com/openai/plugins.git`, ref
   `refs/codex/curated-sync`, synced at startup into `$CODEX_HOME/.tmp/plugins` with SHA in
   `$CODEX_HOME/.tmp/plugins.sha`; backup archive from `https://chatgpt.com/backend-api/plugins/export/curated`
   (`codex:codex-rs/core-plugins/src/startup_sync.rs#L26-L34`, `#L61-L67`; name const `lib.rs#L45`).
   Locally: `codex plugin marketplace list --json` -> `{"name":"openai-curated","root":"/home/ahsan/.codex/.tmp/plugins"}`.
2. `openai-curated-remote` (display "OpenAI Curated Remote"): the ChatGPT-backend remote catalog. Other remote
   pseudo-marketplaces: `created-by-me-remote`, `workspace-directory`, `workspace-shared-with-me[-private|-unlisted]`
   (`codex:codex-rs/core-plugins/src/remote.rs#L93-L106`). Cached at
   `$CODEX_HOME/cache/remote_plugin_catalog/<hash>.json` (local file, schema_version 1, `fetched_at`, `plugins[]`
   with `id`, `name`, `installation_policy`, `authentication_policy`, `eligible_plan_types`, `release{version,
   display_name, description, app_ids, ...}`).

### Browse

- TUI: `/plugins` slash command, "browse plugins" (`codex:codex-rs/tui/src/slash_command.rs#L68`, `#L152`).
- CLI: `codex plugin list [-m MARKETPLACE] [--json] [--available]`. JSON output shape (local run):
  `{"installed":[{pluginId,name,marketplaceName,version,installed,enabled,source:{source,id},installPolicy,authPolicy}], "available":[...]}`.
- App-server: `plugin/list` (section 4).

---

## 3. Install / uninstall / enable / disable

### CLI

```
codex plugin add <PLUGIN@MARKETPLACE> [--json]
codex plugin add <PLUGIN> --marketplace <MARKETPLACE> [--json]
codex plugin remove <PLUGIN@MARKETPLACE> [--json]      # "Uninstall a plugin and remove its local cache"
codex plugin remove <PLUGIN> --marketplace <MARKETPLACE>
```

(`codex plugin add --help`, `codex plugin remove --help`; `codex:codex-rs/cli/src/plugin_cmd.rs#L60-L78`.)
There is NO `install`, `uninstall`, `enable` or `disable` subcommand (verified: `codex plugin enable` ->
"unrecognized subcommand").

### config.toml

Enable state lives in `$CODEX_HOME/config.toml`:

```toml
[plugins."demo@market"]
enabled = true
```

(`PluginConfig { enabled: bool (default true), mcp_servers }`, `codex:codex-rs/config/src/types.rs#L934-L941`;
top-level `plugins: HashMap<String, PluginConfig>` and `marketplaces: HashMap<String, MarketplaceConfig>`,
`codex:codex-rs/config/src/config_toml.rs#L481-L487`; expected TOML from test
`codex:codex-rs/config/src/plugin_edit.rs#L199-L205`. Docs show the same block:
`https://developers.openai.com/plugins/build/plugins`.)

- Install copies the plugin into the cache, then writes `enabled = true` (`manager.rs#L2256-L2260` ->
  `set_user_plugin_enabled`, `plugin_edit.rs#L21-L34`).
- Uninstall deletes the cache dir `plugins/cache/<marketplace>/<plugin>` and removes the whole
  `[plugins."id"]` table (`store.rs#L379-L381`, `manager.rs#L2309-L2330` -> `clear_user_plugin`, `plugin_edit.rs#L36-L38`).
- Disable = set `enabled = false` (keep the table). There is no CLI for this; use config edit or the app-server
  config RPC (section 4).
- For local marketplaces, "installed" means: a `[plugins."id"]` entry exists AND the cache dir exists;
  "enabled" means the entry has `enabled = true` (`manager.rs#L3521-L3538`).
- Remote-catalog plugins (`@openai-curated-remote`) are different: install/uninstall also call the ChatGPT backend
  (`remote_legacy::enable_remote_plugin` / `uninstall_remote_plugin`, `manager.rs#L2082-L2120`, `#L2288-L2307`).
  Their installed state is account-side. Locally my `config.toml` has no `[plugins]` table, yet
  `codex plugin list --json` reports `openai-templates@openai-curated-remote` and
  `plugin-management@openai-curated-remote` as `installed: true, enabled: true, installPolicy: INSTALLED_BY_DEFAULT`.

Plugin ID: `<plugin>@<marketplace>`, parsed with `rsplit_once('@')` (`codex:codex-rs/plugin/src/plugin_id.rs#L26-L46`).
Plugin names may contain `.` (letters, digits, `.`, `_`, `-`); marketplace names may not (`#L51-L70`).

### Cache on disk

- `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/` (`store.rs#L26`, `#L131-L139`; docs:
  `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/`).
- Per-plugin data: `$CODEX_HOME/plugins/data/<plugin>-<marketplace>` (`store.rs#L27`, `#L141-L146`).
- Remote installs add `<plugin>/.codex-remote-plugin-install.json` = `{"schema_version":1,"remote_plugin_id":"plugin_..."}`
  (`store.rs#L29-L30`; local file `~/.codex/plugins/cache/openai-curated-remote/openai-templates/.codex-remote-plugin-install.json`).
- Staging: `$CODEX_HOME/plugins/.remote-plugin-install-staging` (local).

---

## 4. App-server JSON-RPC API

Yes. Methods defined in `codex:codex-rs/app-server-protocol/src/protocol/common.rs#L892-L961` and `#L1030-L1039`.
Types in `codex:codex-rs/app-server-protocol/src/protocol/v2/plugin.rs`. All fields camelCase.
Optional fields are `T | null` in TS.

| Method | Params | Response |
|---|---|---|
| `marketplace/add` | `{source, refName?, sparsePaths?}` | `{marketplaceName, installedRoot, alreadyAdded}` (L66-L84) |
| `marketplace/remove` | `{marketplaceName}` | `{marketplaceName, installedRoot?}` (L86-L99) |
| `marketplace/upgrade` | `{marketplaceName?}` | `{selectedMarketplaces[], upgradedRoots[], errors[{marketplaceName,message}]}` (L101-L124) |
| `plugin/list` | `{cwds?, marketplaceKinds?, forceRefetch?}` | `{marketplaces: PluginMarketplaceEntry[], marketplaceLoadErrors[], featuredPluginIds[]}` (L125-L186) |
| `plugin/installed` | `{cwds?, installSuggestionPluginNames?}` | `{marketplaces[], marketplaceLoadErrors[]}` (L142-L195) |
| `plugin/read` | `{marketplacePath?, remoteMarketplaceName?, pluginName}` | `{plugin: PluginDetail}` (L248-L265) |
| `plugin/install` | `{marketplacePath?, remoteMarketplaceName?, installAttemptId?, pluginName}` | `{authPolicy, appsNeedingAuth: AppSummary[]}` (L950-L971) |
| `plugin/uninstall` | `{pluginId}` (`name@marketplace`) | `{}` (L972-L982) |
| `plugin/reconcile` | `{reason?}` | `{changedPlugins[{id,hasMcps,hasApps,hasHooks,hasSkills}], failedRemotePluginIds[], failedMaterializationRemotePluginIds[]}` (L196-L239) |
| `plugin/skill/read` | `{remoteMarketplaceName, remotePluginId, skillName}` | `{contents?}` (L266-L280) |
| `plugin/search` | experimental (`plugin_search.rs`) | |
| `plugin/share/{save,updateTargets,list,checkout,delete}` | remote sharing | (L282-L455) |

`marketplaceKinds` values: `local`, `vertical`, `workspace-directory`, `shared-with-me`, `created-by-me-remote`
(L155-L175). Omitting `cwds` means only home-scoped marketplaces plus the curated one (doc comment L129-L131).

Key shapes (L615-L931):

```ts
PluginMarketplaceEntry = { name, path: string|null /* marketplace.json path; null for remote */,
                           interface: {displayName}|null, plugins: PluginSummary[] }
PluginSummary = { id /* name@marketplace */, remotePluginId, version, localVersion, name, shareContext,
                  source: PluginSource, installed, installedAt, enabled,
                  installPolicy: "NOT_AVAILABLE"|"AVAILABLE"|"INSTALLED_BY_DEFAULT", installPolicySource,
                  mustShowInstallationInterstitial, authPolicy: "ON_INSTALL"|"ON_USE",
                  availability: "AVAILABLE"|"DISABLED_BY_ADMIN", disabledReason, eligiblePlanTypes,
                  interface: PluginInterface|null, keywords }
PluginSource = {type:"local", path} | {type:"git", url, path, refName, sha}
             | {type:"npm", package, version, registry} | {type:"remote"}
PluginInterface = { displayName, shortDescription, longDescription, developerName, category, capabilities[],
                    websiteUrl, privacyPolicyUrl, termsOfServiceUrl, defaultPrompt[], brandColor,
                    composerIcon, composerIconUrl, logo, logoDark, logoUrl, logoUrlDark, screenshots[], screenshotUrls[] }
PluginDetail = { marketplaceName, marketplacePath, summary, shareUrl, description, skills: SkillSummary[],
                 onboardingSkill, hooks[{key,eventName}], apps: AppSummary[], appTemplates[], mcpServers: string[],
                 scheduledTasks }
```

To install you pass the marketplace by `marketplacePath` (the absolute marketplace.json path from
`PluginMarketplaceEntry.path`) for local marketplaces, or `remoteMarketplaceName` for remote ones, plus the bare
`pluginName`. Uninstall takes the full `pluginId`.

### Enable / disable over app-server

There is no `plugin/enable` method. Use `config/value/write` or `config/batchWrite`
(`common.rs#L1417-L1426`) with key path `plugins.<id>.enabled`, or `plugins.<id>` with `{enabled}`.
The app-server scans the edits and emits plugin toggle events
(`codex:codex-rs/app-server/src/request_processors/config_processor.rs#L245-L277`,
`codex:codex-rs/core-plugins/src/toggles.rs#L4-L40`). Params:

```ts
config/value/write: { keyPath: "plugins.demo@market.enabled", value: false, mergeStrategy: "replace"|"upsert",
                      filePath?, expectedVersion? }
config/batchWrite:  { edits: [{keyPath, value, mergeStrategy}], filePath?, expectedVersion?, reloadUserConfig? }
```

(`codex:codex-rs/app-server-protocol/src/protocol/v2/config.rs#L337-L343`, `#L1072-L1107`.)
Caveat: `toggles.rs` splits key paths on `.`, so a plugin name containing a dot does not parse in the dotted
`plugins.<id>.enabled` form. Use the `plugins.<id>` table form or the whole `plugins` object form (both handled in
`toggles.rs#L20-L36`) — but whether the config writer itself accepts a dotted id in the key path was not verified.

Per-thread disable (0.155+): `thread/settings/update` and `turn/start` accept `disabledPluginIds`
(`codex:codex-rs/app-server/README.md#L256-L268`; `v2/thread.rs#L195`, `#L241`). README says "Saving this
selection does not yet filter plugin capabilities", but the 0.156.0 notes list "#44655 Honor thread-level plugin
exclusions across runtime capabilities" (`gh release view rust-v0.156.0 -R openai/codex`).

---

## 5. Per-profile home

Mostly yes: config, cache, data, curated checkout, added marketplaces, and the remote catalog cache are all under
`CODEX_HOME` (defaults to `~/.codex`; must exist and be a directory if set,
`codex:codex-rs/utils/home-dir/src/lib.rs#L6-L59`).

Exceptions an app must know:

- The personal marketplace `~/.agents/plugins/marketplace.json` is resolved from `HOME`, not `CODEX_HOME`, so it
  is shared across Codex profiles (`marketplace.rs#L303-L311`, `#L466-L471`).
- Repo marketplaces (`<repo>/.agents/plugins/marketplace.json` or `.claude-plugin/marketplace.json`) depend on
  the `cwds` passed.
- A `local` marketplace source in `[marketplaces.x]` points at an arbitrary path outside CODEX_HOME.
- Remote (`@openai-curated-remote`) installed state is tied to the ChatGPT account, not the directory.

---

## 6. Differences from Claude Code that a shared UI must handle

| Topic | Claude Code | Codex |
|---|---|---|
| Install verb | `claude plugin install name@mkt [-s user\|project\|local]` | `codex plugin add name@mkt` (no scope) |
| Uninstall | `claude plugin uninstall id [-s] [-a] [--keep-data]` | `codex plugin remove id` |
| Enable/disable | `claude plugin enable/disable id` | none in CLI; edit `[plugins."id"] enabled` or `config/value/write` |
| Install record | `plugins/installed_plugins.json` (v2, per-scope list with `installPath`, `version`, `gitCommitSha`) | no separate file; `[plugins."id"]` table + cache dir presence |
| Enabled state | `enabledPlugins` in `settings.json` (user/project/local/managed) | `[plugins."id"].enabled` in `config.toml` (user layer; project `.codex/config.toml` also read per docs) |
| Marketplaces registry | `plugins/known_marketplaces.json` (`source:{source:"github",repo}`, `installLocation`, `lastUpdated`) | `[marketplaces.<name>]` in `config.toml`; clones under `.tmp/marketplaces/<name>` |
| Marketplace file | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` (also reads `.claude-plugin/marketplace.json`) |
| Plugin manifest | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` (also reads `.claude-plugin/` and `.cursor-plugin/`) |
| Marketplace entry | `source` string or `{source:"github"\|"url"\|"git-subdir"\|"npm",...}` | `source` string or `{source:"local"\|"url"\|"git-subdir"\|"npm",...}` + required `policy{installation,authentication}` + `category` |
| Official | `claude-plugins-official` (`anthropics/claude-plugins-official`) | `openai-curated` (`openai/plugins`) + remote `openai-curated-remote` |
| Account plugins | `name@synced` from claude.ai | remote catalog marketplaces (`openai-curated-remote`, workspace, shared) |
| Components | skills, commands, agents, hooks, MCP, LSP, ... | skills, MCP, apps (`.app.json` connectors), hooks; agents/commands present in curated repo |
| Cache | `plugins/cache/<mkt>/<plugin>/<version>` | `plugins/cache/<mkt>/<plugin>/<version>` (same shape) |
| Auth | n/a | `authPolicy` ON_INSTALL/ON_USE; `plugin/install` returns `appsNeedingAuth` the UI must surface |
| Availability | — | `availability` DISABLED_BY_ADMIN, `disabledReason`, `eligiblePlanTypes`, `installPolicy` INSTALLED_BY_DEFAULT |
| Programmatic API | CLI only | app-server JSON-RPC (section 4) |

Practical notes for the app:

- Use app-server `plugin/list` (with `cwds` = project dir) instead of reading files. It merges local, curated
  and remote catalogs and returns `installed`/`enabled` already computed.
- Codex has no scopes. A Claude "scope" picker has no Codex meaning; per-project disable exists only via
  per-thread `disabledPluginIds`.
- Install needs `marketplacePath` (local) or `remoteMarketplaceName` (remote), not just an id string.
- Show app auth needs after install (`appsNeedingAuth`).
- Remote plugins may be `INSTALLED_BY_DEFAULT` and have no config entry.

---

## 7. Claude Code "synced" plugins

From `https://code.claude.com/docs/en/plugins-reference`:

- Plugins enabled on the claude.ai account are downloaded automatically into `~/.claude/plugins/synced/` and load
  with identity `<name>@synced`. There is no marketplace and no install record.
- Disable: `claude plugin disable <name>@synced` writes `"<name>@synced": false` to user-level `enabledPlugins`.
  Re-enable: `claude plugin enable <name>@synced`. A project can block one with `enabledPlugins` in
  `.claude/settings.json`.
- Stop syncing entirely: `syncClaudeAiPlugins: false` in user settings (synced plugins move to `plugins/.trash/`).
- Org-required plugins cannot be disabled ("... is required by your organization and can't be disabled here.").
- If a non-synced plugin with the same name is enabled, it wins and the synced copy is reported as not loaded.
- `claude plugin list` shows them under "Synced from claude.ai".

On-disk layout observed (read-only). The active Claude profile here is
`CLAUDE_CONFIG_DIR=/home/ahsan/.local/share/atelier/profiles/claude/azeem`, so paths are relative to that
(`~/.claude/plugins/synced/` has only an empty bucket):

```
plugins/synced/
  .bucket-<orgUuid>_<accountUuid>            # empty marker file
  <orgUuid>_<accountUuid>/                   # one bucket per account/org
    manifest.json        # {lastUpdated, plugins:[{pluginId:"plugin_01...", name, description, version:"0040",
                         #   updatedAt, marketplaceName, installationPreference:"available", generation?}]}
    .marketplaces.json   # {etag, rows:[{name, scope:"account", source:{source:"github",repo}|{source:"claudeai"}, id, updated_at}], parserVersion}
    design/              # normal plugin dir: .claude-plugin/plugin.json, skills/, .mcp.json, README.md
    design.meta.json     # {server_plugin_id, marketplace_name, installation_preference}
    pdf-viewer~g2/       # "~g2" suffix when manifest entry has generation: 2
    pdf-viewer~g2.meta.json
```

`claude plugin list` reports each as `name@synced` with `Path: .../synced/<bucket>/<dir>` and `Status: loaded`.
Synced plugins do not appear in `installed_plugins.json` (that profile's file is `{"version":2,"plugins":{}}`),
and that profile's `settings.json` has no `enabledPlugins` key: enabled is the default, and only explicit
`false` entries are written.
The directory name is not always the plugin name (`~g2` suffix), so an app should key on `manifest.json` entries
(or on `claude plugin list` output), not on folder names.
