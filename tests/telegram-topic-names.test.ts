import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatClaudeForumTopicName,
  formatCursorForumTopicName,
  formatForumTopicNameForMapping,
} from '../src/server/transports/telegram/topic-names.js';

describe('topic-names', () => {
  it('prefixes Cursor and Claude forum names', () => {
    assert.equal(
      formatCursorForumTopicName('perto_app_v2', 'App update'),
      '🖱️ perto_app_v2 — App update'
    );
    assert.equal(
      formatClaudeForumTopicName('Relay'),
      '🤖 Claude — Relay'
    );
  });

  it('picks emoji from mapping kind', () => {
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
