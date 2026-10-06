import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTrackDurations } from '../src/audio-metadata.mjs';

const audioInstances = [];

class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.duration = 12.3456;
    audioInstances.push(this);
  }

  addEventListener(name, callback) {
    const handlers = this.listeners.get(name) || [];
    handlers.push(callback);
    this.listeners.set(name, handlers);
  }

  removeEventListener(name, callback) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((handler) => handler !== callback));
  }

  emit(name) {
    for (const handler of this.listeners.get(name) || []) handler();
  }

  load() {}
}

function manifestWithTracks(...tracks) {
  return {
    station: { name: 'Radio', description: 'Test' },
    timelineStartsAt: '2026-01-01T00:00:00Z',
    tracks: tracks.map((id) => ({ id, title: id, artist: 'Artista', audioUrl: `https://audio.example/${id}.mp3` })),
  };
}

test('ricava la durata audio dai metadati e arrotonda al millisecondo', async () => {
  const manifest = manifestWithTracks('one', 'two');
  const result = resolveTrackDurations(manifest, { AudioConstructor: FakeAudio });

  assert.equal(audioInstances.length, 2);
  for (const audio of audioInstances.splice(0)) audio.emit('loadedmetadata');

  const resolved = await result;
  assert.deepEqual(resolved.tracks.map(({ durationMs }) => durationMs), [12346, 12346]);
  assert.equal(manifest.tracks[0].durationMs, undefined);
});

test('usa le durate dichiarate solo quando sono presenti per tutte le tracce', async () => {
  const completeManifest = manifestWithTracks('one', 'two');
  completeManifest.tracks[0].duration = '3:20';
  completeManifest.tracks[1].duration = '1:02.5';

  const declared = await resolveTrackDurations(completeManifest, {
    useManifestDurations: true,
    AudioConstructor: undefined,
  });
  assert.deepEqual(declared.tracks.map(({ durationMs }) => durationMs), [200000, 62500]);
  assert.equal(audioInstances.length, 0);

  const partialManifest = manifestWithTracks('one', 'two');
  partialManifest.tracks[0].duration = '3:20';
  const fallback = resolveTrackDurations(partialManifest, { AudioConstructor: FakeAudio, useManifestDurations: true });
  for (const audio of audioInstances.splice(0)) audio.emit('loadedmetadata');
  assert.deepEqual((await fallback).tracks.map(({ durationMs }) => durationMs), [12346, 12346]);
});

test('segnala esplicitamente una durata dichiarata non valida', async () => {
  const manifest = manifestWithTracks('one');
  manifest.tracks[0].duration = '3:60';
  await assert.rejects(resolveTrackDurations(manifest, {
    useManifestDurations: true,
    AudioConstructor: FakeAudio,
  }), /Durata non valida per la traccia 1/);
});

test('ignora le durate del manifesto se la funzione è disabilitata', async () => {
  const manifest = manifestWithTracks('one');
  manifest.tracks[0].duration = 'formato non valido';
  const resolved = resolveTrackDurations(manifest, { AudioConstructor: FakeAudio });
  audioInstances.splice(0).forEach((audio) => audio.emit('loadedmetadata'));

  assert.equal((await resolved).tracks[0].durationMs, 12346);
});

test('segnala errori e durate dei file non utilizzabili', async () => {
  const failedMetadata = resolveTrackDurations(manifestWithTracks('broken'), { AudioConstructor: FakeAudio });
  audioInstances.splice(0).forEach((audio) => audio.emit('error'));
  await assert.rejects(failedMetadata, /Durata non disponibile per la traccia 1 \(broken\).*metadati/);

  const invalidDuration = resolveTrackDurations(manifestWithTracks('empty'), { AudioConstructor: FakeAudio });
  audioInstances.splice(0).forEach((audio) => {
    audio.duration = Number.POSITIVE_INFINITY;
    audio.emit('loadedmetadata');
  });
  await assert.rejects(invalidDuration, /durata finita e positiva/);
});
