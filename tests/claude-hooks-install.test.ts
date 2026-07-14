import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { installClaudeHooks } from '../src/server/claude-hooks-install.js';

describe('installClaudeHooks', () => {
  it('merges http hooks without wiping unrelated settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-claude-hooks-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify({
      permissions: { defaultMode: 'bypassPermissions' },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }, null, 2));

    const changed = installClaudeHooks('http://127.0.0.1:3000/api/claude/hooks', path);
    assert.equal(changed, true);

    const out = JSON.parse(readFileSync(path, 'utf-8')) as {
      permissions: { defaultMode: string };
      hooks: Record<string, Array<{ hooks: Array<{ type: string; url?: string; command?: string }> }>>;
    };
    assert.equal(out.permissions.defaultMode, 'bypassPermissions');
    assert.ok(out.hooks.Stop.some((e) => e.hooks.some((h) => h.command === 'echo hi')));
    assert.ok(out.hooks.PermissionRequest.some((e) =>
      e.hooks.some((h) => h.type === 'http' && h.url?.includes('/api/claude/hooks/PermissionRequest'))
    ));
    assert.ok(out.hooks.Notification.some((e) =>
      e.hooks.some((h) => h.type === 'http' && h.url?.includes('/api/claude/hooks/Notification'))
    ));
    assert.ok(out.hooks.UserPromptSubmit.some((e) =>
      e.hooks.some((h) => h.type === 'http' && h.url?.includes('/api/claude/hooks/UserPromptSubmit'))
    ));

    // idempotent
    assert.equal(installClaudeHooks('http://127.0.0.1:3000/api/claude/hooks', path), false);

    rmSync(dir, { recursive: true, force: true });
  });
});
