import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countWords, estimateDuration, targetWordRange } from './scripts.js';

test('counts Russian words, numbers and hyphenated words', () => {
  assert.equal(countWords('Это короткий тест: 30 секунд и Санкт-Петербург.'), 7);
});

test('returns separate budgets for 30 and 60 second videos', () => {
  assert.deepEqual(targetWordRange(30), { min: 58, max: 68 });
  assert.deepEqual(targetWordRange(60), { min: 118, max: 136 });
});

test('estimates narration duration from the selected voice speed', () => {
  assert.equal(estimateDuration(Array(68).fill('слово').join(' '), 136), 30);
});
