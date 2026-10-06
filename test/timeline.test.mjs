import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSchedule, locateTrack } from '../src/timeline.mjs';

const manifest = {
  timelineStartsAt: '2026-01-01T00:00:00.000Z',
  tracks: [
    { id: 'one', durationMs: 1000 },
    { id: 'two', durationMs: 2500 },
    { id: 'three', durationMs: 500 },
  ],
};
const start = Date.parse(manifest.timelineStartsAt);

test('individua la prima traccia all’inizio e durante la riproduzione', () => {
  assert.deepEqual(locateTrack(manifest, start), {
    index: 0,
    track: manifest.tracks[0],
    startsAt: start,
    endsAt: start + 1000,
    offsetMs: 0,
    elapsedMs: 0,
    cycleIndex: 0,
  });
  assert.equal(locateTrack(manifest, start + 725).offsetMs, 725);
});

test('usa intervalli semiaperti nel passaggio tra tracce', () => {
  const position = locateTrack(manifest, start + 1000);

  assert.equal(position.index, 1);
  assert.equal(position.track.id, 'two');
  assert.equal(position.offsetMs, 0);
  assert.equal(position.startsAt, start + 1000);
  assert.equal(position.cycleIndex, 0);
});

test('segnala i tempi precedenti all’inizio della programmazione', () => {
  const position = locateTrack(manifest, start - 1);

  assert.equal(position.track, null);
  assert.equal(position.index, -1);
  assert.equal(position.elapsedMs, -1);
  assert.equal(position.cycleIndex, 0);
});

test('segnala la fine esatta e i tempi successivi alla scaletta', () => {
  const end = start + 4000;

  for (const timestamp of [end, end + 1]) {
    const position = locateTrack(manifest, timestamp);
    assert.equal(position.track, null);
    assert.equal(position.index, -1);
  }
  assert.equal(locateTrack(manifest, end).elapsedMs, 4000);
  assert.equal(locateTrack(manifest, end).cycleIndex, 0);
});

test('ripete la scaletta sulla timeline assoluta senza drift ai confini di ciclo', () => {
  const repeatingManifest = { ...manifest, repeat: true };
  const positions = [
    [start + 3999, 'three', 499, 0],
    [start + 4000, 'one', 0, 1],
    [start + 5000, 'two', 0, 1],
    [start + 7999, 'three', 499, 1],
    [start + 8000, 'one', 0, 2],
  ];

  for (const [timestamp, id, offsetMs, cycleIndex] of positions) {
    const position = locateTrack(repeatingManifest, timestamp);
    assert.equal(position.track.id, id);
    assert.equal(position.offsetMs, offsetMs);
    assert.equal(position.cycleIndex, cycleIndex);
  }

  const secondCycleStart = locateTrack(repeatingManifest, start + 4000);
  assert.equal(secondCycleStart.startsAt, start + 4000);
  assert.equal(secondCycleStart.endsAt, start + 5000);
  assert.equal(locateTrack(repeatingManifest, start - 1).track, null);
});

test('costruisce gli orari consecutivi senza sovrapposizioni', () => {
  assert.deepEqual(buildSchedule(manifest).map(({ track, index, startsAt, endsAt }) => ({
    id: track.id,
    index,
    startsAt,
    endsAt,
  })), [
    { id: 'one', index: 0, startsAt: start, endsAt: start + 1000 },
    { id: 'two', index: 1, startsAt: start + 1000, endsAt: start + 3500 },
    { id: 'three', index: 2, startsAt: start + 3500, endsAt: start + 4000 },
  ]);
});
