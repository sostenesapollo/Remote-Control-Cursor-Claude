import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPIC_ICON_COLOR,
  TOPIC_ICON_EMOJI,
  topicIconForPhase,
  topicIconForSnapshot,
  topicPhaseFromSnapshot,
} from '../src/server/transports/telegram/topic-icons.js';

describe('topic-icons', () => {
  it('maps agent statuses to distinct phases', () => {
    assert.equal(topicPhaseFromSnapshot('idle'), 'idle');
    assert.equal(topicPhaseFromSnapshot('thinking'), 'thinking');
    assert.equal(topicPhaseFromSnapshot('generating'), 'generating');
    assert.equal(topicPhaseFromSnapshot('running_tool'), 'running_tool');
    assert.equal(topicPhaseFromSnapshot('waiting_approval'), 'waiting_approval');
    assert.equal(topicPhaseFromSnapshot('error'), 'error');
  });

  it('pending approvals override idle/running to waiting_approval', () => {
    assert.equal(topicPhaseFromSnapshot('idle', 1), 'waiting_approval');
    assert.equal(topicPhaseFromSnapshot('generating', 2), 'waiting_approval');
  });

  it('finished/idle uses green check; new uses blue star', () => {
    const idle = topicIconForPhase('idle');
    assert.equal(idle.iconColor, TOPIC_ICON_COLOR.green);
    assert.equal(idle.iconCustomEmojiId, TOPIC_ICON_EMOJI.check);

    const neu = topicIconForPhase('new');
    assert.equal(neu.iconColor, TOPIC_ICON_COLOR.blue);
    assert.equal(neu.iconCustomEmojiId, TOPIC_ICON_EMOJI.star);
  });

  it('running_tool uses yellow bolt; error uses red double-alert', () => {
    const run = topicIconForSnapshot('running_tool');
    assert.equal(run.phase, 'running_tool');
    assert.equal(run.iconColor, TOPIC_ICON_COLOR.yellow);
    assert.equal(run.iconCustomEmojiId, TOPIC_ICON_EMOJI.bolt);

    const err = topicIconForSnapshot('error');
    assert.equal(err.iconColor, TOPIC_ICON_COLOR.red);
    assert.equal(err.iconCustomEmojiId, TOPIC_ICON_EMOJI.doubleAlert);
  });
});
