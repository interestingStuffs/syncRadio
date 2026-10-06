import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import {
  loadStationManifest,
  parseCsvManifest,
  validateManifest,
} from '../src/data-source.mjs';

const originalDocument = globalThis.document;
const originalFetch = globalThis.fetch;
globalThis.document = { baseURI: 'https://radio.example/live/' };

after(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const validManifest = {
  station: { name: 'Radio manifesto ignorata', description: 'Metadati non più usati' },
  tracks: [{
    id: 'one',
    title: 'Brano',
    artist: 'Artista',
    audioUrl: './audio/one.mp3',
  }],
};

function mockFetch(t, response) {
  t.mock.method(globalThis, 'fetch', async () => response);
}

function manifestResponse(text, {
  contentType = 'application/json',
  status = 200,
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    text: async () => text,
  };
}

test('valida il manifesto, applica la data della stazione e risolve URL audio relativi', () => {
  assert.deepEqual(validateManifest(validManifest, '2026-01-01T00:00:00Z'), {
    timelineStartsAt: '2026-01-01T00:00:00Z',
    tracks: [{
      ...validManifest.tracks[0],
      audioUrl: 'https://radio.example/live/audio/one.mp3',
    }],
  });
});

test('rifiuta manifesti incompleti, date senza fuso e scalette vuote', () => {
  assert.throws(() => validateManifest(null, '2026-01-01T00:00:00Z'), /lista di tracce/);
  assert.throws(() => validateManifest({ ...validManifest, tracks: [] }, '2026-01-01T00:00:00Z'), /almeno una traccia/);
  assert.throws(() => validateManifest(validManifest, '2026-01-01T00:00:00'), /fuso orario/);
});

test('rifiuta identificativi duplicati e non richiede la durata nel manifesto', () => {
  assert.throws(() => validateManifest({
    ...validManifest,
    tracks: [...validManifest.tracks, { ...validManifest.tracks[0] }],
  }, '2026-01-01T00:00:00Z'), /Identificativo duplicato/);
  const manifest = validateManifest({
    ...validManifest,
    tracks: [{ ...validManifest.tracks[0], durationMs: 0 }],
  }, '2026-01-01T00:00:00Z');
  assert.equal('durationMs' in manifest.tracks[0], false);
  assert.equal('duration' in manifest.tracks[0], false);
});

test('rifiuta URL audio con protocollo non supportato', () => {
  assert.throws(() => validateManifest({
    ...validManifest,
    tracks: [{ ...validManifest.tracks[0], audioUrl: 'javascript:alert(1)' }],
  }, '2026-01-01T00:00:00Z'), /HTTP o HTTPS/);
});

test('interpreta CSV quotati usando solo le colonne delle tracce', () => {
  const csv = [
    'id,title,artist,audioUrl',
    'one,"Titolo',
    'su due righe",Artista,https://audio.example/one.mp3',
  ].join('\r\n');
  const manifest = validateManifest(parseCsvManifest(csv), '2026-01-01T00:00:00Z');

  assert.equal('station' in manifest, false);
  assert.equal(manifest.tracks[0].title, 'Titolo\r\nsu due righe');
});

test('conserva la colonna opzionale duration del CSV e la durata JSON', () => {
  const csv = [
    'id,title,artist,audioUrl,duration',
    'one,Brano,Artista,https://audio.example/one.mp3,3:20',
  ].join('\n');
  assert.equal(parseCsvManifest(csv).tracks[0].duration, '3:20');

  const manifest = validateManifest({
    ...validManifest,
    tracks: [{ ...validManifest.tracks[0], duration: '3:19.750' }],
  }, '2026-01-01T00:00:00Z');
  assert.equal(manifest.tracks[0].duration, '3:19.750');
});

test('rifiuta intestazioni mancanti e CSV non chiuso', () => {
  assert.throws(() => parseCsvManifest('id,title\none,Brano'), /Intestazioni CSV mancanti/);
  assert.throws(() => parseCsvManifest('a,b\n"non chiuso,x'), /virgolette non chiuso/);
});

test('carica un manifesto JSON usando il content type', async (t) => {
  mockFetch(t, manifestResponse(JSON.stringify(validManifest)));
  const manifest = await loadStationManifest('https://radio.example/manifest', '2026-01-01T00:00:00Z');

  assert.equal('station' in manifest, false);
  assert.equal(manifest.timelineStartsAt, '2026-01-01T00:00:00Z');
  assert.equal(manifest.tracks[0].audioUrl, 'https://radio.example/live/audio/one.mp3');
});

test('carica un manifesto CSV usando l’estensione URL', async (t) => {
  const csv = [
    'id,title,artist,audioUrl',
    'one,Brano,Artista,https://audio.example/one.mp3',
  ].join('\n');
  mockFetch(t, manifestResponse(csv, { contentType: 'text/plain' }));

  const manifest = await loadStationManifest('https://radio.example/station.csv', '2026-01-01T00:00:00Z');
  assert.equal(manifest.tracks.length, 1);
  assert.equal(manifest.timelineStartsAt, '2026-01-01T00:00:00Z');
});

test('segnala URL assente, errori HTTP, JSON invalido e timeout', async (t) => {
  await assert.rejects(loadStationManifest('', '2026-01-01T00:00:00Z'), /Configura manifestUrl/);

  mockFetch(t, manifestResponse('', { status: 404 }));
  await assert.rejects(loadStationManifest('/missing.json', '2026-01-01T00:00:00Z'), /HTTP 404/);

  mockFetch(t, manifestResponse('{'));
  await assert.rejects(loadStationManifest('/broken.json', '2026-01-01T00:00:00Z'), /JSON valido/);

  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('timeout', 'TimeoutError');
  });
  await assert.rejects(loadStationManifest('/slow.json', '2026-01-01T00:00:00Z'), /Timeout durante/);
});
