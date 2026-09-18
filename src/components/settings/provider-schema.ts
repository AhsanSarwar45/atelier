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
}

export type Control =
  | {
      kind: 'choice';
      choices: Choice[];
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
  { value: 'auto', label: 'Auto', hint: 'Classifier decides' },
  { value: 'dontAsk', label: "Don't ask", hint: 'Refuses instead' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Nothing asks' },
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
          { key: 'model', label: 'Model', description: '', control: { kind: 'choice', choices: CLAUDE_MODELS, free: true } },
          { key: 'effortLevel', label: 'Effort', description: '', control: { kind: 'choice', choices: CLAUDE_EFFORT } },
          { key: 'maxEffortLevel', label: 'Effort ceiling', description: 'Lowest across files wins', control: { kind: 'choice', choices: [...CLAUDE_EFFORT, { value: 'max', label: 'Max' }] } },
          { key: 'alwaysThinkingEnabled', label: 'Extended thinking', description: '', control: yesNo },
          { key: 'fallbackModel', label: 'Fallback models', description: 'Tried in order', control: { kind: 'list', placeholder: 'sonnet' } },
        ],
      },
      {
        id: 'behaviour',
        title: 'Behaviour',
        settings: [
          { key: 'outputStyle', label: 'Output style', description: '', control: { kind: 'choice', free: true, plus: 'outputStyles', choices: [
            { value: 'Default', label: 'Default' }, { value: 'Proactive', label: 'Proactive' }, { value: 'Concise', label: 'Concise' }, { value: 'Explanatory', label: 'Explanatory' }, { value: 'Learning', label: 'Learning' },
          ] } },
          { key: 'language', label: 'Language', description: '', control: { kind: 'choice', free: true, choices: LANGUAGES } },
          { key: 'autoCompactEnabled', label: 'Compact automatically', description: '', control: yesNo },
          { key: 'autoCompactWindow', label: 'Compact at', description: 'Tokens', control: { kind: 'number', min: 100000, max: 1000000, step: 10000 } },
          { key: 'autoMemoryEnabled', label: 'Auto memory', description: '', control: yesNo },
          { key: 'cleanupPeriodDays', label: 'Keep transcripts for', description: 'Days', control: { kind: 'number', min: 1, max: 3650 } },
          { key: 'attribution.commit', label: 'Commit trailer', description: 'Empty hides it', control: { kind: 'text', placeholder: 'Co-Authored-By: …' } },
          { key: 'attribution.pr', label: 'Pull request line', description: 'Empty hides it', control: { kind: 'text' } },
        ],
      },
      {
        id: 'terminal',
        title: 'In the terminal',
        description: 'Terminal only',
        settings: [
          { key: 'theme', label: 'Theme', description: '', control: { kind: 'choice', free: true, choices: [
            { value: 'auto', label: 'Auto' }, { value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'dark-daltonized', label: 'Dark, colour-blind' }, { value: 'light-daltonized', label: 'Light, colour-blind' }, { value: 'dark-ansi', label: 'Dark ANSI' }, { value: 'light-ansi', label: 'Light ANSI' },
          ] } },
          { key: 'editorMode', label: 'Prompt editing', description: '', control: { kind: 'choice', choices: [{ value: 'normal', label: 'Normal' }, { value: 'vim', label: 'Vim' }] } },
          { key: 'preferredNotifChannel', label: 'Notifications', description: '', control: { kind: 'choice', choices: [
            { value: 'auto', label: 'Auto' }, { value: 'terminal_bell', label: 'Terminal bell' }, { value: 'iterm2', label: 'iTerm2' }, { value: 'iterm2_with_bell', label: 'iTerm2 with bell' }, { value: 'kitty', label: 'Kitty' }, { value: 'ghostty', label: 'Ghostty' }, { value: 'notifications_disabled', label: 'Off' },
          ] } },
          { key: 'spinnerTipsEnabled', label: 'Tips under the spinner', description: '', control: yesNo },
          { key: 'autoUpdatesChannel', label: 'Updates', description: '', control: { kind: 'choice', choices: [{ value: 'latest', label: 'Latest' }, { value: 'stable', label: 'Stable' }] } },
        ],
      },
      {
        id: 'env',
        title: 'Environment',
        settings: [
          { key: 'env', label: 'Environment variables', description: '', control: { kind: 'map' } },
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
          { key: 'permissions.defaultMode', label: 'Starting mode', description: '', control: { kind: 'choice', choices: CLAUDE_PERMISSION_MODES } },
          { key: 'permissions.disableBypassPermissionsMode', label: 'Forbid bypass', description: '', control: { kind: 'choice', choices: [{ value: 'disable', label: 'Forbidden' }] } },
          { key: 'skipDangerousModePermissionPrompt', label: 'Skip the bypass warning', description: '', control: yesNo, scopes: ['account'] },
          { key: 'permissions.blockReadsOutsideWorkingDirectories', label: 'Block reads outside the project', description: 'Even in bypass mode', control: yesNo },
        ],
      },
      {
        id: 'rules',
        title: 'Rules',
        description: 'One per line, e.g. Bash(git *)',
        settings: [
          { key: 'permissions.allow', label: 'Always allow', description: '', control: { kind: 'list', placeholder: 'Bash(npm test)' } },
          { key: 'permissions.ask', label: 'Always ask', description: '', control: { kind: 'list', placeholder: 'Bash(git push *)' } },
          { key: 'permissions.deny', label: 'Never allow', description: 'Even in bypass mode', control: { kind: 'list', placeholder: 'Read(./.env)' } },
          { key: 'permissions.additionalDirectories', label: 'Extra directories', description: 'Outside the project', control: { kind: 'list', placeholder: '~/notes' } },
        ],
      },
      {
        id: 'sandbox',
        title: 'Sandbox',
        settings: [
          { key: 'sandbox.enabled', label: 'Sandbox commands', description: '', control: yesNo },
          { key: 'sandbox.autoAllowBashIfSandboxed', label: 'Allow sandboxed commands without asking', description: '', control: yesNo },
          // A boolean, on by default, and off is what `/sandbox` calls strict
          // sandbox mode. It was drawn as a choice between two strings the
          // provider accepts neither of, so whichever the reader picked the
          // setting did nothing at all (bw-6ecp.8).
          { key: 'sandbox.allowUnsandboxedCommands', label: 'Retry outside the sandbox', description: 'Off refuses the retry, so every command must run sandboxed', control: yesNo },
          { key: 'sandbox.excludedCommands', label: 'Never sandbox', description: 'Commands', control: { kind: 'list', placeholder: 'docker' } },
          { key: 'sandbox.network.allowedDomains', label: 'Allowed domains', description: '', control: { kind: 'list', placeholder: 'github.com' } },
          { key: 'sandbox.network.deniedDomains', label: 'Denied domains', description: '', control: { kind: 'list' } },
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

export const CODEX_MODELS: Choice[] = [
  { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
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
          { key: 'model', label: 'Model', description: '', control: { kind: 'choice', choices: CODEX_MODELS, free: true } },
          { key: 'model_reasoning_effort', label: 'Reasoning effort', description: '', control: { kind: 'choice', choices: CODEX_EFFORT } },
          { key: 'plan_mode_reasoning_effort', label: 'Reasoning effort in plan mode', description: '', control: { kind: 'choice', choices: [{ value: 'none', label: 'None' }, ...CODEX_EFFORT] } },
          { key: 'model_reasoning_summary', label: 'Reasoning summary', description: '', control: { kind: 'choice', choices: [{ value: 'auto', label: 'Auto' }, { value: 'concise', label: 'Concise' }, { value: 'detailed', label: 'Detailed' }, { value: 'none', label: 'None' }] } },
          { key: 'model_verbosity', label: 'Verbosity', description: '', control: { kind: 'choice', choices: [{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }] } },
          { key: 'personality', label: 'Personality', description: '', control: { kind: 'choice', choices: [{ value: 'none', label: 'None' }, { value: 'friendly', label: 'Friendly' }, { value: 'pragmatic', label: 'Pragmatic' }] } },
          { key: 'review_model', label: 'Review model', description: 'For /review', control: { kind: 'choice', choices: CODEX_MODELS, free: true } },
          { key: 'model_context_window', label: 'Context window', description: 'Tokens', control: { kind: 'number', min: 1000 } },
          { key: 'model_auto_compact_token_limit', label: 'Compact at', description: 'Tokens', control: { kind: 'number', min: 1000 } },
        ],
      },
      {
        id: 'behaviour',
        title: 'Behaviour',
        settings: [
          { key: 'web_search', label: 'Web search', description: '', control: { kind: 'choice', choices: [{ value: 'disabled', label: 'Off' }, { value: 'cached', label: 'Cached' }, { value: 'indexed', label: 'Indexed' }, { value: 'live', label: 'Live' }] } },
          { key: 'hide_agent_reasoning', label: 'Hide reasoning', description: '', control: yesNo },
          { key: 'show_raw_agent_reasoning', label: 'Show raw reasoning', description: 'Experimental', control: yesNo },
          { key: 'history.persistence', label: 'Keep history', description: '', control: { kind: 'choice', choices: [{ value: 'save-all', label: 'Save everything' }, { value: 'none', label: 'Save nothing' }] } },
          { key: 'file_opener', label: 'Open files in', description: '', control: { kind: 'choice', choices: [{ value: 'vscode', label: 'VS Code' }, { value: 'vscode-insiders', label: 'VS Code Insiders' }, { value: 'cursor', label: 'Cursor' }, { value: 'windsurf', label: 'Windsurf' }, { value: 'none', label: 'Nowhere' }] } },
          { key: 'check_for_update_on_startup', label: 'Check for updates on start', description: '', control: yesNo },
          { key: 'project_doc_max_bytes', label: 'Instructions size limit', description: 'Bytes', control: { kind: 'number', min: 1024 } },
        ],
      },
      {
        id: 'features',
        title: 'Features',
        settings: [
          { key: 'features.hooks', label: 'Hooks', description: '', control: yesNo },
          { key: 'features.memories', label: 'Memories', description: '', control: yesNo },
          { key: 'features.multi_agent', label: 'Multiple agents', description: '', control: yesNo },
          { key: 'features.fast_mode', label: 'Fast mode', description: '', control: yesNo },
          { key: 'features.apps', label: 'Apps', description: '', control: yesNo },
          { key: 'features.shell_snapshot', label: 'Shell snapshot', description: '', control: yesNo },
          { key: 'features.unified_exec', label: 'Unified exec', description: '', control: yesNo },
        ],
      },
      {
        id: 'env',
        title: 'Environment',
        settings: [
          { key: 'shell_environment_policy.inherit', label: 'Inherit the shell environment', description: '', control: { kind: 'choice', choices: [{ value: 'all', label: 'All of it' }, { value: 'core', label: 'The core variables' }, { value: 'none', label: 'None' }] } },
          { key: 'shell_environment_policy.set', label: 'Set variables', description: '', control: { kind: 'map' } },
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
          { key: 'approval_policy', label: 'When to ask', description: '', control: { kind: 'choice', choices: [{ value: 'on-request', label: 'When the model asks' }, { value: 'never', label: 'Never' }] } },
          { key: 'approvals_reviewer', label: 'Approval reviewer', description: '', control: { kind: 'choice', choices: [{ value: 'user', label: 'You' }, { value: 'auto_review', label: 'Automatic review' }] } },
        ],
      },
      {
        id: 'sandbox',
        title: 'Sandbox',
        description: 'Ignored when a profile is set',
        settings: [
          { key: 'sandbox_mode', label: 'Sandbox', description: '', control: { kind: 'choice', choices: [{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Write in the workspace' }, { value: 'danger-full-access', label: 'Full access' }] } },
          { key: 'sandbox_workspace_write.network_access', label: 'Network access', description: 'While writing', control: yesNo },
          { key: 'sandbox_workspace_write.writable_roots', label: 'Also writable', description: 'Outside the workspace', control: { kind: 'list', placeholder: '/tmp/scratch' } },
          { key: 'sandbox_workspace_write.exclude_tmpdir_env_var', label: 'Keep $TMPDIR read-only', description: '', control: yesNo },
          { key: 'sandbox_workspace_write.exclude_slash_tmp', label: 'Keep /tmp read-only', description: '', control: yesNo },
        ],
      },
      {
        id: 'profile',
        title: 'Permission profile',
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
