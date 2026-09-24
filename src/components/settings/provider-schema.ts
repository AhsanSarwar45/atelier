/**
 * What each provider's settings file can say, written down once.
 *
 * The screens for Claude Code and Codex are drawn from these tables rather
 * than each control being hand-placed: a key's name, what it means in plain
 * words, the control that edits it and the values it takes. Both come from the
 * providers' own references, read 2026-09-13 (Claude Code 2.1.268, Codex
 * 0.153.4); the card bw-2t1c holds the notes.
 *
 * A key is addressed by its dotted path in the file, which is also how the
 * server's `provider-settings.write` patch names it.
 */

export type Brand = 'claude' | 'codex';

export interface Choice {
  value: string;
  label: string;
  hint?: string;
  /**
   * Where this one value is honoured, when the key itself is honoured in both.
   *
   * `permissions.defaultMode` is read from any settings file, but two of its
   * values are not: `auto` and `bypassPermissions` take effect only from user,
   * `--settings` or managed settings, and from a project or local file they are
   * ignored without a word. Offering them on the project screen was offering a
   * choice that does nothing (bw-6ecp.10).
   */
  scopes?: ('account' | 'project')[];
}

export type Control =
  | {
      kind: 'choice';
      choices: Choice[];
      /**
       * The key also takes a table, which this control cannot draw. When the
       * file holds one it is shown as it is, and replacing it takes a click.
       */
      table?: string;
      /** Also accept a value not in the list. */
      free?: boolean;
      /** Choices read from the scope's own files and added to the list. */
      plus?: 'outputStyles';
    }
  | { kind: 'toggle' }
  | { kind: 'text'; placeholder?: string; mono?: boolean }
  | { kind: 'number'; min?: number; max?: number; step?: number }
  /** A list of strings, one per line. */
  | { kind: 'list'; placeholder?: string }
  /** A table of name → value strings. */
  | { kind: 'map' };

export interface SettingDef {
  key: string;
  label: string;
  description: string;
  control: Control;
  /** Where the key is honoured. Both when omitted. */
  scopes?: ('account' | 'project')[];
}

export interface SettingGroupDef {
  id: string;
  title: string;
  description?: string;
  settings: SettingDef[];
}

/** The pages a provider's section is split into. */
export interface ProviderPageDef {
  id: string;
  label: string;
  groups: SettingGroupDef[];
}

const yesNo = { kind: 'toggle' } as const;

export const LANGUAGES: Choice[] = ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Japanese', 'Chinese', 'Korean', 'Russian', 'Arabic', 'Hindi', 'Urdu'].map((name) => ({ value: name, label: name }));

export const CLAUDE_MODELS: Choice[] = [
  { value: 'default', label: 'Default' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'opusplan', label: 'Opus for plans, Sonnet for work' },
  { value: 'opus[1m]', label: 'Opus, 1M context' },
  { value: 'sonnet[1m]', label: 'Sonnet, 1M context' },
];

export const CLAUDE_EFFORT: Choice[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

export const CLAUDE_PERMISSION_MODES: Choice[] = [
  { value: 'default', label: 'Ask', hint: 'Asks first time' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'Edits pass, commands ask' },
  { value: 'plan', label: 'Plan', hint: 'Read only' },
  { value: 'auto', label: 'Auto', hint: 'Classifier decides', scopes: ['account'] },
  { value: 'dontAsk', label: "Don't ask", hint: 'Refuses instead' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Nothing asks', scopes: ['account'] },
];

export const CLAUDE_PAGES: ProviderPageDef[] = [
  {
    id: 'defaults',
    label: 'Defaults',
    groups: [
      {
        id: 'model',
        title: 'Model',
        settings: [
          { key: 'model', label: 'Model', description: 'Used when a chat does not choose another model', control: { kind: 'choice', choices: CLAUDE_MODELS, free: true } },
          { key: 'effortLevel', label: 'Effort', description: 'How much reasoning the model uses by default', control: { kind: 'choice', choices: CLAUDE_EFFORT } },
          { key: 'maxEffortLevel', label: 'Effort ceiling', description: 'Maximum effort allowed; the lowest configured ceiling wins', control: { kind: 'choice', choices: [...CLAUDE_EFFORT, { value: 'max', label: 'Max' }] } },
          { key: 'alwaysThinkingEnabled', label: 'Extended thinking', description: 'Allow longer reasoning before an answer', control: yesNo },
          { key: 'fallbackModel', label: 'Fallback models', description: 'Tried in order when the selected model is unavailable', control: { kind: 'list', placeholder: 'sonnet' } },
        ],
      },
      {
        id: 'behaviour',
        title: 'Behaviour',
        settings: [
          { key: 'language', label: 'Language', description: 'Preferred language for responses', control: { kind: 'choice', free: true, choices: LANGUAGES } },
          { key: 'autoCompactEnabled', label: 'Compact automatically', description: 'Summarize older context before the limit is reached', control: yesNo },
          { key: 'autoCompactWindow', label: 'Compact at', description: 'Token count that starts automatic compaction', control: { kind: 'number', min: 100000, max: 1000000, step: 10000 } },
          { key: 'autoMemoryEnabled', label: 'Auto memory', description: 'Let Claude save useful details between chats', control: yesNo },
          // A minimum of 1 and no maximum. The 3650 this once had was nobody's
          // but ours, and it refused a number Claude Code accepts (bw-6ecp.12).
          { key: 'cleanupPeriodDays', label: 'Keep transcripts for', description: 'Days', control: { kind: 'number', min: 1 } },
          { key: 'attribution.commit', label: 'Commit trailer', description: 'Empty hides it', control: { kind: 'text', placeholder: 'Co-Authored-By: …' } },
          { key: 'attribution.pr', label: 'Pull request line', description: 'Empty hides it', control: { kind: 'text' } },
        ],
      },
      {
        id: 'terminal',
        title: 'In the terminal',
        description: 'Terminal only',
        settings: [
          { key: 'theme', label: 'Theme', description: 'Colours used by Claude in the terminal', control: { kind: 'choice', free: true, choices: [
            { value: 'auto', label: 'Auto' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'dark-daltonized', label: 'Dark, colour-blind' }, { value: 'light-daltonized', label: 'Light, colour-blind' }, { value: 'dark-ansi', label: 'Dark ANSI' }, { value: 'light-ansi', label: 'Light ANSI' },
          ] } },
          { key: 'editorMode', label: 'Prompt editing', description: 'Keyboard behaviour in the terminal prompt', control: { kind: 'choice', choices: [{ value: 'normal', label: 'Normal' }, { value: 'vim', label: 'Vim' }] } },
          { key: 'preferredNotifChannel', label: 'Notifications', description: 'How the terminal announces completed work', control: { kind: 'choice', choices: [
            { value: 'auto', label: 'Auto' }, { value: 'terminal_bell', label: 'Terminal bell' }, { value: 'iterm2', label: 'iTerm2' }, { value: 'iterm2_with_bell', label: 'iTerm2 with bell' }, { value: 'kitty', label: 'Kitty' }, { value: 'ghostty', label: 'Ghostty' }, { value: 'notifications_disabled', label: 'Off' },
          ] } },
          { key: 'spinnerTipsEnabled', label: 'Tips under the spinner', description: 'Show usage tips while Claude is working', control: yesNo },
          { key: 'autoUpdatesChannel', label: 'Updates', description: 'Choose which Claude releases are installed', control: { kind: 'choice', choices: [{ value: 'latest', label: 'Latest' }, { value: 'stable', label: 'Stable' }] } },
        ],
      },
      {
        id: 'env',
        title: 'Environment',
        settings: [
          { key: 'env', label: 'Environment variables', description: 'Added whenever Claude starts', control: { kind: 'map' } },
        ],
      },
    ],
  },
  {
    id: 'permissions',
    label: 'Permissions',
    groups: [
      {
        id: 'mode',
        title: 'Mode',
        settings: [
          { key: 'permissions.defaultMode', label: 'Starting mode', description: 'Permission mode used for new chats', control: { kind: 'choice', choices: CLAUDE_PERMISSION_MODES } },
          { key: 'permissions.disableBypassPermissionsMode', label: 'Forbid bypass', description: 'Prevent chats from using bypass mode', control: { kind: 'choice', choices: [{ value: 'disable', label: 'Forbidden' }] } },
          { key: 'skipDangerousModePermissionPrompt', label: 'Skip the bypass warning', description: 'Do not show the confirmation prompt for bypass mode', control: yesNo, scopes: ['account'] },
          { key: 'permissions.blockReadsOutsideWorkingDirectories', label: 'Block reads outside the project', description: 'Even in bypass mode', control: yesNo },
        ],
      },
      {
        id: 'rules',
        title: 'Rules',
        description: 'One per line, e.g. Bash(git *)',
        settings: [
          { key: 'permissions.allow', label: 'Always allow', description: 'Matching tools run without confirmation', control: { kind: 'list', placeholder: 'Bash(npm test)' } },
          { key: 'permissions.ask', label: 'Always ask', description: 'Matching tools always require confirmation', control: { kind: 'list', placeholder: 'Bash(git push *)' } },
          { key: 'permissions.deny', label: 'Never allow', description: 'Even in bypass mode', control: { kind: 'list', placeholder: 'Read(./.env)' } },
          { key: 'permissions.additionalDirectories', label: 'Extra directories', description: 'Outside the project', control: { kind: 'list', placeholder: '~/notes' } },
        ],
      },
      {
        id: 'sandbox',
        title: 'Sandbox',
        settings: [
          { key: 'sandbox.enabled', label: 'Sandbox commands', description: 'Restrict shell commands to approved files and resources', control: yesNo },
          { key: 'sandbox.autoAllowBashIfSandboxed', label: 'Allow sandboxed commands without asking', description: 'Skip confirmation when the sandbox contains the command', control: yesNo },
          // A boolean, on by default, and off is what `/sandbox` calls strict
          // sandbox mode. It was drawn as a choice between two strings the
          // provider accepts neither of, so whichever the reader picked the
          // setting did nothing at all (bw-6ecp.8).
          { key: 'sandbox.allowUnsandboxedCommands', label: 'Retry outside the sandbox', description: 'Off requires sandboxing', control: yesNo },
          { key: 'sandbox.excludedCommands', label: 'Never sandbox', description: 'Commands', control: { kind: 'list', placeholder: 'docker' } },
          { key: 'sandbox.network.allowedDomains', label: 'Allowed domains', description: 'Network destinations available inside the sandbox', control: { kind: 'list', placeholder: 'github.com' } },
          { key: 'sandbox.network.deniedDomains', label: 'Denied domains', description: 'Network destinations blocked inside the sandbox', control: { kind: 'list' } },
        ],
      },
    ],
  },
];

export const CODEX_EFFORT: Choice[] = [
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

/**
 * The models Codex will still run, read 2026-09-19.
 *
 * GPT-5.4 and 5.4 mini retired from Codex on 2026-08-31 and were still offered
 * here, so picking one wrote a model Codex refuses; 5.3 Codex Spark is in
 * neither the reference nor the CLI (bw-6ecp.9). The list is `free`, so a model
 * newer than this table can still be typed in.
 * Source: https://learn.chatgpt.com/docs/models
 */
export const CODEX_MODELS: Choice[] = [
  { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5', hint: 'Retires 14 Oct 2026' },
];

export const CODEX_PAGES: ProviderPageDef[] = [
  {
    id: 'defaults',
    label: 'Defaults',
    groups: [
      {
        id: 'model',
        title: 'Model',
        settings: [
          { key: 'model', label: 'Model', description: 'Used when a chat does not choose another model', control: { kind: 'choice', choices: CODEX_MODELS, free: true } },
          { key: 'model_reasoning_effort', label: 'Reasoning effort', description: 'How much reasoning the model uses by default', control: { kind: 'choice', choices: CODEX_EFFORT } },
          { key: 'plan_mode_reasoning_effort', label: 'Reasoning effort in plan mode', description: 'Reasoning used while creating or updating a plan', control: { kind: 'choice', choices: [{ value: 'none', label: 'None' }, ...CODEX_EFFORT] } },
          { key: 'model_reasoning_summary', label: 'Reasoning summary', description: 'Amount of reasoning shown with the answer', control: { kind: 'choice', choices: [{ value: 'auto', label: 'Auto' }, { value: 'concise', label: 'Concise' }, { value: 'detailed', label: 'Detailed' }, { value: 'none', label: 'None' }] } },
          { key: 'model_verbosity', label: 'Verbosity', description: 'Default level of detail in responses', control: { kind: 'choice', choices: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] } },
          { key: 'personality', label: 'Personality', description: 'Default tone for responses', control: { kind: 'choice', choices: [{ value: 'none', label: 'None' }, { value: 'friendly', label: 'Friendly' }, { value: 'pragmatic', label: 'Pragmatic' }] } },
          { key: 'review_model', label: 'Review model', description: 'For /review', control: { kind: 'choice', choices: CODEX_MODELS, free: true } },
          { key: 'model_context_window', label: 'Context window', description: 'Tokens', control: { kind: 'number', min: 1000 } },
          { key: 'model_auto_compact_token_limit', label: 'Compact at', description: 'Tokens', control: { kind: 'number', min: 1000 } },
        ],
      },
      {
        id: 'behaviour',
        title: 'Behaviour',
        settings: [
          { key: 'web_search', label: 'Web search', description: 'How Codex retrieves current web results', control: { kind: 'choice', choices: [{ value: 'disabled', label: 'Off' }, { value: 'cached', label: 'Cached' }, { value: 'indexed', label: 'Indexed' }, { value: 'live', label: 'Live' }] } },
          { key: 'hide_agent_reasoning', label: 'Hide reasoning', description: 'Hide reasoning details from the transcript', control: yesNo },
          { key: 'show_raw_agent_reasoning', label: 'Show raw reasoning', description: 'Show experimental unprocessed reasoning output', control: yesNo },
          { key: 'history.persistence', label: 'Keep history', description: 'Choose whether chats are saved on this computer', control: { kind: 'choice', choices: [{ value: 'save-all', label: 'Save everything' }, { value: 'none', label: 'Save nothing' }] } },
          { key: 'file_opener', label: 'Open files in', description: 'App used when Codex opens a local file', control: { kind: 'choice', choices: [{ value: 'vscode', label: 'VS Code' }, { value: 'vscode-insiders', label: 'VS Code Insiders' }, { value: 'cursor', label: 'Cursor' }, { value: 'windsurf', label: 'Windsurf' }, { value: 'none', label: 'Nowhere' }] } },
          { key: 'check_for_update_on_startup', label: 'Check for updates on start', description: 'Look for a newer Codex release when it starts', control: yesNo },
          { key: 'project_doc_max_bytes', label: 'Instructions size limit', description: 'Bytes', control: { kind: 'number', min: 1024 } },
        ],
      },
      {
        id: 'features',
        title: 'Features',
        settings: [
          { key: 'features.hooks', label: 'Hooks', description: 'Run configured commands around Codex actions', control: yesNo },
          { key: 'features.memories', label: 'Memories', description: 'Let Codex retain useful details between chats', control: yesNo },
          { key: 'features.multi_agent', label: 'Multiple agents', description: 'Allow Codex to delegate work to subagents', control: yesNo },
          { key: 'features.fast_mode', label: 'Fast mode', description: 'Use the faster response mode when available', control: yesNo },
          { key: 'features.apps', label: 'Apps', description: 'Allow connected app tools', control: yesNo },
          { key: 'features.shell_snapshot', label: 'Shell snapshot', description: 'Reuse captured shell state for commands', control: yesNo },
          { key: 'features.unified_exec', label: 'Unified exec', description: 'Run shell commands through the unified executor', control: yesNo },
        ],
      },
      {
        id: 'env',
        title: 'Environment',
        settings: [
          { key: 'shell_environment_policy.inherit', label: 'Shell environment', description: 'Environment variables inherited by commands', control: { kind: 'choice', choices: [{ value: 'all', label: 'All' }, { value: 'core', label: 'Core variables' }, { value: 'none', label: 'None' }] } },
          { key: 'shell_environment_policy.set', label: 'Set variables', description: 'Variables added or replaced for every command', control: { kind: 'map' } },
        ],
      },
    ],
  },
  {
    id: 'permissions',
    label: 'Approvals and sandbox',
    groups: [
      {
        id: 'approvals',
        title: 'Approvals',
        settings: [
          // Also takes a table — `{ granular = { … } }` — which the screen has
          // no control for. Marked so a config using it is shown as it is
          // rather than read as unset and overwritten (bw-6ecp.13).
          { key: 'approval_policy', label: 'When to ask', description: 'When commands require approval before they run', control: { kind: 'choice', choices: [{ value: 'on-request', label: 'When the model asks' }, { value: 'never', label: 'Never' }], table: 'granular' } },
          { key: 'approvals_reviewer', label: 'Approval reviewer', description: 'Who decides whether approval requests are allowed', control: { kind: 'choice', choices: [{ value: 'user', label: 'You' }, { value: 'auto_review', label: 'Automatic review' }] } },
        ],
      },
      {
        id: 'sandbox',
        title: 'Sandbox',
        // The reference says not to combine these with `default_permissions`
        // at all. Calling it an override said the profile quietly wins, which
        // is not what happens (bw-6ecp.14).
        description: 'Cannot be combined with a permission profile',
        settings: [
          { key: 'sandbox_mode', label: 'Sandbox', description: 'Files and resources commands may access', control: { kind: 'choice', choices: [{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Write in the workspace' }, { value: 'danger-full-access', label: 'Full access' }] } },
          { key: 'sandbox_workspace_write.network_access', label: 'Network access', description: 'While writing', control: yesNo },
          { key: 'sandbox_workspace_write.writable_roots', label: 'Also writable', description: 'Outside the workspace', control: { kind: 'list', placeholder: '/tmp/scratch' } },
          { key: 'sandbox_workspace_write.exclude_tmpdir_env_var', label: 'Keep $TMPDIR read-only', description: 'Prevent writes to the configured temporary directory', control: yesNo },
          { key: 'sandbox_workspace_write.exclude_slash_tmp', label: 'Keep /tmp read-only', description: 'Prevent writes to /tmp', control: yesNo },
        ],
      },
      {
        id: 'profile',
        title: 'Permission profile',
        description: 'Cannot be combined with sandbox settings',
        settings: [
          { key: 'default_permissions', label: 'Profile', description: 'Or :read-only, :workspace, :danger-full-access', control: { kind: 'text', placeholder: ':workspace', mono: true } },
        ],
      },
    ],
  },
];

export function pagesFor(brand: Brand): ProviderPageDef[] {
  return brand === 'claude' ? CLAUDE_PAGES : CODEX_PAGES;
}
