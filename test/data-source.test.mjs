import assert from 'node:assert/strict';
import { after, afterEach, test } from 'node:test';
import {
  loadStationCatalog,
  validateStationCatalog,
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

const validStation = {
  id: 'radio',
  name: 'Radio',
  description: 'Descrizione',
  timelineStartsAt: '2026-01-01T00:00:00Z',
  repeat: true,
  tracks: [{
    id: 'one',
    title: 'Brano',
    artist: 'Artista',
    audioUrl: 'audio/one.mp3',
    duration: '3:20',
  }],
};

function mockFetch(t, response) {
  t.mock.method(globalThis, 'fetch', async () => response);
}

function catalogResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

test('valida le stazioni e risolve gli URL audio rispetto al catalogo', () => {
  assert.deepEqual(validateStationCatalog(
    { stations: [validStation] },
    'https://radio.example/assets/stations.json',
  ), [{
    id: 'radio',
    name: 'Radio',
    description: 'Descrizione',
    timelineStartsAt: '2026-01-01T00:00:00Z',
    repeat: true,
    tracks: [{
      id: 'one',
      title: 'Brano',
      artist: 'Artista',
      audioUrl: 'https://radio.example/assets/audio/one.mp3',
      duration: '3:20',
    }],
  }]);
});

test('rifiuta cataloghi, stazioni e scalette non validi', () => {
  assert.throws(() => validateStationCatalog(null), /lista di stazioni/);
  assert.throws(() => validateStationCatalog({ stations: [] }), /almeno una stazione/);
  assert.throws(() => validateStationCatalog({ stations: [validStation, validStation] }), /Identificativo duplicato/);
  assert.throws(() => validateStationCatalog({
    stations: [{ ...validStation, timelineStartsAt: '2026-01-01T00:00:00' }],
  }), /fuso orario/);
  assert.throws(() => validateStationCatalog({
    stations: [{ ...validStation, repeat: 'true' }],
  }), /repeat deve essere true o false/);
  assert.throws(() => validateStationCatalog({
    stations: [{ ...validStation, tracks: [] }],
  }), /almeno una traccia/);
  assert.throws(() => validateStationCatalog({
    stations: [{
      ...validStation,
      tracks: [...validStation.tracks, { ...validStation.tracks[0] }],
    }],
  }), /Identificativo duplicato/);
  assert.throws(() => validateStationCatalog({
    stations: [{
      ...validStation,
      tracks: [{ ...validStation.tracks[0], audioUrl: 'javascript:alert(1)' }],
    }],
  }), /HTTP o HTTPS/);
});

test('normalizza i campi delle tracce e non richiede le durate', () => {
  const station = validateStationCatalog({
    stations: [{
      ...validStation,
      tracks: [{
        id: 'one',
        title: 'Brano',
        artist: 'Artista',
        audioUrl: 'audio/one.mp3',
        durationMs: 120000,
      }],
    }],
  })[0];
  assert.equal('duration' in station.tracks[0], false);
  assert.equal('durationMs' in station.tracks[0], false);
});

test('carica il catalogo JSON', async (t) => {
  mockFetch(t, catalogResponse(JSON.stringify({ stations: [validStation] })));
  const stations = await loadStationCatalog('https://radio.example/assets/stations.json');
  assert.equal(stations.length, 1);
  assert.equal(stations[0].tracks[0].audioUrl, 'https://radio.example/assets/audio/one.mp3');
});

test('segnala URL assente, errori HTTP, JSON invalido e timeout', async (t) => {
  await assert.rejects(loadStationCatalog(''), /Configura stationCatalogUrl/);

  mockFetch(t, catalogResponse('', 404));
  await assert.rejects(loadStationCatalog('/missing.json'), /HTTP 404/);

  mockFetch(t, catalogResponse('{'));
  await assert.rejects(loadStationCatalog('/broken.json'), /JSON valido/);

  t.mock.method(globalThis, 'fetch', async () => {
    throw new DOMException('timeout', 'TimeoutError');
  });
  await assert.rejects(loadStationCatalog('/slow.json'), /Timeout durante/);
});
