import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatClaudeForumTopicName,
  formatCursorForumTopicName,
  formatForumTopicNameForMapping,
} from '../src/server/transports/telegram/topic-names.js';

describe('topic-names', () => {
  it('prefixes Cursor and Claude forum names', () => {
    delete process.env.AGENT_NAME;
    delete process.env.TELEGRAM_AGENT_LABEL;
    assert.equal(
      formatCursorForumTopicName('perto_app_v2', 'App update'),
      '🖱️ perto_app_v2 — App update'
    );
    assert.equal(
      formatClaudeForumTopicName('Relay'),
      '🤖 Claude — Relay'
    );
  });

  it('inserts AGENT_NAME tag when set', () => {
    process.env.AGENT_NAME = 'Sosteness';
    try {
      assert.equal(
        formatCursorForumTopicName('perto_app_v2', 'App update'),
        '🖱️ Sosteness · perto_app_v2 — App update'
      );
      assert.equal(
        formatClaudeForumTopicName('Relay'),
        '🤖 Sosteness · Claude — Relay'
      );
    } finally {
      delete process.env.AGENT_NAME;
    }
  });

  it('picks emoji from mapping kind', () => {
    delete process.env.AGENT_NAME;
    assert.equal(
      formatForumTopicNameForMapping({
        windowId: 'abc',
        windowTitle: 'CursorRemote',
        tabTitle: 'Chat',
      }),
      '🖱️ CursorRemote — Chat'
    );
    assert.equal(
      formatForumTopicNameForMapping({
        windowId: 'claude::deadbeef',
        windowTitle: 'Claude — Relay',
        tabTitle: 'Claude',
      }),
      '🤖 Claude — Relay'
    );
  });
});
