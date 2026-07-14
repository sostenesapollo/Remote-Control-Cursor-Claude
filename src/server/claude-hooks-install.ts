import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

type HookHandler = {
  type: string;
  url?: string;
  timeout?: number;
  [key: string]: unknown;
};

type HookEntry = {
  matcher?: string;
  hooks: HookHandler[];
};

type ClaudeSettings = {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
};

const CURSOR_REMOTE_MARKER = 'cursor-remote-claude-bridge';

const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Notification',
  'PermissionRequest',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SubagentStop',
] as const;

function isOurHook(handler: HookHandler): boolean {
  if (handler.type !== 'http' || typeof handler.url !== 'string') return false;
  return handler.url.includes('/api/claude/hooks');
}

/**
 * Merge CursorRemote Claude HTTP hooks into ~/.claude/settings.json.
 * Preserves unrelated hooks. Returns true when the file was modified.
 */
export function installClaudeHooks(
  hooksBaseUrl: string,
  settingsPath = join(homedir(), '.claude', 'settings.json')
): boolean {
  const base = hooksBaseUrl.replace(/\/$/, '');
  mkdirSync(dirname(settingsPath), { recursive: true });

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeSettings;
    } catch {
      settings = {};
    }
  }

  const hooks = { ...(settings.hooks ?? {}) };
  let changed = false;

  for (const event of EVENTS) {
    const existing = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    const withoutOurs = existing.filter(
      (entry) => !(entry.hooks ?? []).some((h) => isOurHook(h))
    );

    const targetUrl = `${base}/${event}`;
    const entry: HookEntry = {
      hooks: [
        {
          type: 'http',
          url: targetUrl,
          // Long enough for Telegram Allow/Deny on PermissionRequest.
          timeout: event === 'PermissionRequest' || event === 'PreToolUse' ? 300 : 15,
          // marker kept in URL query? keep via comment field if supported — use custom header-less id in url path only
        },
      ],
    };

    // Annotate with a query marker so uninstall/filter stays stable if URL host changes.
    entry.hooks[0].url = `${targetUrl}?src=${CURSOR_REMOTE_MARKER}`;

    const next = [...withoutOurs, entry];
    const before = JSON.stringify(existing);
    const after = JSON.stringify(next);
    if (before !== after) {
      hooks[event] = next;
      changed = true;
    } else {
      hooks[event] = next;
    }
  }

  if (!changed) {
    // Still rewrite if file lacked our hooks structurally with same JSON? check presence
    const hasAll = EVENTS.every((event) =>
      (hooks[event] ?? []).some((e) => (e.hooks ?? []).some((h) => isOurHook(h)))
    );
    if (hasAll) return false;
    changed = true;
  }

  if (existsSync(settingsPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(settingsPath, `${settingsPath}.bak-cursor-remote-${stamp}`);
  }

  const nextSettings: ClaudeSettings = {
    ...settings,
    hooks,
  };
  writeFileSync(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, 'utf-8');
  return true;
}
