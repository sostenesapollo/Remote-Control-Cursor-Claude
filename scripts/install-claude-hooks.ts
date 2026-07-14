#!/usr/bin/env npx tsx
/**
 * Install CursorRemote Claude Code HTTP hooks into ~/.claude/settings.json
 *
 * Usage:
 *   npx tsx scripts/install-claude-hooks.ts
 *   npx tsx scripts/install-claude-hooks.ts http://127.0.0.1:3000/api/claude/hooks
 */
import { installClaudeHooks } from '../src/server/claude-hooks-install.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3000/api/claude/hooks';
const changed = installClaudeHooks(base);
console.log(changed
  ? `[ok] Wrote Claude hooks → ${base}/<Event>`
  : `[ok] Hooks already present for ${base}`);
