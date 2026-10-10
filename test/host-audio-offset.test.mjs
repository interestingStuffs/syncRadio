import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHostAudioOffset } from '../src/host-audio-offset.mjs';

test('accetta offset host in millisecondi e arrotonda all’intero più vicino', () => {
  assert.equal(parseHostAudioOffset('125'), 125);
  assert.equal(parseHostAudioOffset('-125.6'), -126);
});

test('limita l’offset host allo stesso intervallo dell’offset personale', () => {
  assert.equal(parseHostAudioOffset('9000'), 5000);
  assert.equal(parseHostAudioOffset('-9000'), -5000);
});

test('usa zero per un parametro host mancante o non valido', () => {
  assert.equal(parseHostAudioOffset(null), 0);
  assert.equal(parseHostAudioOffset(''), 0);
  assert.equal(parseHostAudioOffset('not-a-number'), 0);
  assert.equal(parseHostAudioOffset('Infinity'), 0);
});
