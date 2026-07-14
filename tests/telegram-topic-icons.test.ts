import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPIC_ICON_COLOR,
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

  it('uses colored circle palette (waiting=blue, idle=green, new=pink)', () => {
    assert.equal(topicIconForPhase('waiting_approval').iconColor, TOPIC_ICON_COLOR.blue);
    assert.equal(topicIconForPhase('idle').iconColor, TOPIC_ICON_COLOR.green);
    assert.equal(topicIconForPhase('new').iconColor, TOPIC_ICON_COLOR.pink);
    assert.equal(topicIconForPhase('error').iconColor, TOPIC_ICON_COLOR.red);
    assert.equal(topicIconForPhase('thinking').iconColor, TOPIC_ICON_COLOR.purple);
    assert.equal(topicIconForPhase('running_tool').iconColor, TOPIC_ICON_COLOR.yellow);
  });

  it('snapshot helper respects approval override color', () => {
    const style = topicIconForSnapshot('idle', 1);
    assert.equal(style.phase, 'waiting_approval');
    assert.equal(style.iconColor, TOPIC_ICON_COLOR.blue);
  });
});
