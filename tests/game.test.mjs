import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  applyImpostorHistory,
  calculateRoundResult,
  finalizeRound,
  formatTime,
  getImpostorCount,
  pickWord,
  selectImpostors,
  selectTarget,
  validateWordData,
} from '../game.js';

function makePlayer(id, overrides = {}) {
  return {
    id,
    name: id.toUpperCase(),
    score: 0,
    streak: 0,
    cooldown: 0,
    lastImpostorRound: null,
    ...overrides,
  };
}

function makeRound(number, impostorIds, targetId) {
  return {
    number,
    impostorIds,
    targetId,
    categoryName: 'Test',
    word: 'Widget',
  };
}

test('impostor count is 1 for 4-6 players and 2 for 7+', () => {
  assert.equal(getImpostorCount(4), 1);
  assert.equal(getImpostorCount(6), 1);
  assert.equal(getImpostorCount(7), 2);
  assert.equal(getImpostorCount(12), 2);
});

test('formatTime renders a five-minute countdown', () => {
  assert.equal(formatTime(300_000), '5:00');
  assert.equal(formatTime(61_000), '1:01');
  assert.equal(formatTime(59_999), '1:00');
  assert.equal(formatTime(0), '0:00');
});

test('selectImpostors returns distinct eligible players', () => {
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => makePlayer(id));
  const result = selectImpostors(players, 2);
  assert.equal(result.ids.length, 2);
  assert.equal(new Set(result.ids).size, 2);
  assert.deepEqual(result.forcedIds, []);
});

test('selectImpostors avoids players on cooldown when possible', () => {
  const players = [
    makePlayer('a'),
    makePlayer('b', { cooldown: 2 }),
    makePlayer('c', { cooldown: 1, streak: 1 }),
  ];
  const result = selectImpostors(players, 1);
  assert.deepEqual(result.ids, ['a']);
  assert.deepEqual(result.forcedIds, []);
});

test('selectImpostors falls back when everyone is on cooldown', () => {
  const players = [
    makePlayer('a', { cooldown: 2, streak: 2 }),
    makePlayer('b', { cooldown: 2, streak: 2 }),
    makePlayer('c', { cooldown: 1, streak: 1 }),
  ];
  const result = selectImpostors(players, 1);
  assert.equal(result.ids.length, 1);
  assert.equal(result.forcedIds.length, 1);
});

test('selectTarget always chooses an innocent player', () => {
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => makePlayer(id));
  const targetId = selectTarget(players, ['a', 'b']);
  assert.ok(targetId);
  assert.ok(!['a', 'b'].includes(targetId));
});

test('history allows two consecutive impostor rounds, then a two-round cooldown', () => {
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => makePlayer(id));

  applyImpostorHistory(players, makeRound(1, ['a', 'b'], 'c'));
  assert.equal(players[0].streak, 1);
  assert.equal(players[0].cooldown, 0);

  applyImpostorHistory(players, makeRound(2, ['a', 'b'], 'c'));
  assert.equal(players[0].streak, 2);
  assert.equal(players[0].cooldown, 2);
  assert.equal(players[1].streak, 2);
  assert.equal(players[1].cooldown, 2);

  applyImpostorHistory(players, makeRound(3, ['c', 'd'], 'e'));
  assert.equal(players[0].cooldown, 1);
  assert.equal(players[0].streak, 2);

  applyImpostorHistory(players, makeRound(4, ['e', 'f'], 'c'));
  assert.equal(players[0].cooldown, 0);
  assert.equal(players[0].streak, 0);
  assert.equal(players[1].cooldown, 0);
  assert.equal(players[1].streak, 0);
});

test('pickWord respects categories and rotates hints', () => {
  const data = {
    categories: [
      {
        id: 'one',
        name: 'One',
        words: [{ word: 'Only', hints: ['first', 'second', 'third'] }],
      },
      {
        id: 'two',
        name: 'Two',
        words: [{ word: 'Other', hints: ['alpha', 'beta', 'gamma'] }],
      },
    ],
  };

  const first = pickWord(data, ['one'], [], {});
  assert.equal(first.categoryId, 'one');
  assert.equal(first.hint, 'first');
  assert.equal(first.nextHintUsage, 1);
  assert.equal(first.reset, false);

  const second = pickWord(data, ['one'], [], { 'one:Only': 1 });
  assert.equal(second.hint, 'second');

  const reset = pickWord(data, ['one'], ['one:Only'], {});
  assert.equal(reset.reset, true);
  assert.equal(reset.word, 'Only');

  const filtered = pickWord(data, ['two'], [], {});
  assert.equal(filtered.categoryId, 'two');
  assert.equal(filtered.word, 'Other');
});

test('scoring: caught impostor gives every innocent 5 points', () => {
  const players = ['a', 'b', 'c', 'd'].map((id) => makePlayer(id));
  const result = calculateRoundResult(players, makeRound(1, ['a'], 'b'), 'a');
  assert.equal(result.caught, true);
  assert.equal(result.points.a, 0);
  assert.equal(result.points.b, 5);
  assert.equal(result.points.c, 5);
  assert.equal(result.points.d, 5);
});

test('scoring: surviving impostor gets 15, target hit gets 30', () => {
  const players = ['a', 'b', 'c', 'd'].map((id) => makePlayer(id));

  const normal = calculateRoundResult(players, makeRound(1, ['a'], 'b'), 'c');
  assert.equal(normal.points.a, 15);

  const target = calculateRoundResult(players, makeRound(1, ['a'], 'b'), 'b');
  assert.equal(target.targetHit, true);
  assert.equal(target.points.a, 30);
  assert.equal(target.points.b, 0);
});

test('scoring: two impostors are team-based and share a target bonus', () => {
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => makePlayer(id));

  const caught = calculateRoundResult(players, makeRound(1, ['a', 'b'], 'c'), 'a');
  assert.equal(caught.caught, true);
  assert.equal(caught.points.a, 0);
  assert.equal(caught.points.b, 0);
  assert.equal(caught.points.c, 5);
  assert.equal(caught.points.g, 5);

  const target = calculateRoundResult(players, makeRound(1, ['a', 'b'], 'c'), 'c');
  assert.equal(target.targetHit, true);
  assert.equal(target.points.a, 30);
  assert.equal(target.points.b, 30);

  const survived = calculateRoundResult(players, makeRound(1, ['a', 'b'], 'c'), 'd');
  assert.equal(survived.points.a, 15);
  assert.equal(survived.points.b, 15);
});

test('finalizeRound applies points and history for a played round', () => {
  const players = ['a', 'b', 'c', 'd'].map((id) => makePlayer(id));
  players[0].score = 10;
  const outcome = finalizeRound(players, makeRound(1, ['a'], 'b'), { votedOutId: 'b' });
  assert.equal(outcome.skipped, false);
  assert.equal(players[0].score, 40);
  assert.equal(players[0].streak, 1);
  assert.equal(players[1].score, 0);
});

test('finalizeRound skips points and history when the round is skipped', () => {
  const players = ['a', 'b', 'c', 'd'].map((id) => makePlayer(id));
  players[0].score = 12;
  players[0].streak = 1;
  players[0].cooldown = 1;

  const outcome = finalizeRound(players, makeRound(1, ['a'], 'b'), { skipped: true });
  assert.equal(outcome.skipped, true);
  assert.equal(players[0].score, 12);
  assert.equal(players[0].streak, 1);
  assert.equal(players[0].cooldown, 1);
});

test('the shipped word data is valid and fully populated', () => {
  const raw = readFileSync(new URL('../data/words.json', import.meta.url), 'utf8');
  const data = validateWordData(JSON.parse(raw));
  assert.equal(data.categories.length, 10);
  for (const category of data.categories) {
    assert.equal(category.words.length, 12);
    for (const entry of category.words) {
      assert.ok(entry.hints.length >= 2 && entry.hints.length <= 3);
    }
  }
});
