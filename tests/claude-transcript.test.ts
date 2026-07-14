import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractLastRoleText } from '../src/server/claude-transcript.js';

describe('extractLastRoleText', () => {
  it('returns the last assistant text block from a JSONL transcript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-claude-tx-'));
    const path = join(dir, 's.jsonl');
    writeFileSync(path, [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'oi' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'primeira' }],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Oi! Tudo bem?' }],
        },
      }),
      '',
    ].join('\n'));

    assert.equal(extractLastRoleText(path, 'assistant'), 'Oi! Tudo bem?');
    assert.equal(extractLastRoleText(path, 'user'), 'oi');
    rmSync(dir, { recursive: true, force: true });
  });
});
