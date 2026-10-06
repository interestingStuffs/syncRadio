import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPlaybackOffset, savePlaybackOffset } from '../src/playback-offset.mjs';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('salva e ripristina l’offset scelto', () => {
  const storage = createStorage();

  assert.equal(savePlaybackOffset(350, storage), 350);
  assert.equal(loadPlaybackOffset(storage), 350);
});

test('limita l’offset e ignora valori memorizzati non validi', () => {
  const storage = createStorage();

  assert.equal(savePlaybackOffset(9000, storage), 5000);
  assert.equal(savePlaybackOffset(-9000, storage), -5000);
  storage.setItem('syncRadio.playbackOffsetMs', 'invalid');
  assert.equal(loadPlaybackOffset(storage), 0);
});