import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { loadConfig } from '../src/config.mjs';

const originalFetch = globalThis.fetch;
const station = {
  id: 'radio',
  name: 'Radio',
  description: 'Descrizione',
  manifestUrl: './station.json',
  timelineStartsAt: '2026-01-01T00:00:00Z',
  repeat: false,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockConfig(t, response) {
  t.mock.method(globalThis, 'fetch', async () => response);
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test('carica e normalizza la configurazione con i valori predefiniti', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [{ ...station, name: ' Radio ', description: ' Descrizione ', manifestUrl: '  ./station.json ' }],
    allowStationSwitch: true,
    timeSources: [{
      name: ' Orologio ',
      url: 'https://time.example/api',
      responsePath: 'data.utc',
    }],
  }));

  assert.deepEqual(await loadConfig(), {
    stations: [{ ...station }],
    allowStationSwitch: true,
    timeSources: [{
      name: 'Orologio',
      url: 'https://time.example/api',
      responsePath: 'data.utc',
      timeZonePath: '',
    }],
    resyncIntervalMs: 30000,
    requestTimeoutMs: 8000,
    localFallback: true,
    useManifestDurations: false,
  });
});

test('accetta una lista vuota di sorgenti e fallback locale disattivato', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    timeSources: [],
    resyncIntervalMs: 15000,
    requestTimeoutMs: 2500,
    localFallback: false,
  }));

  const config = await loadConfig();
  assert.deepEqual(config.timeSources, []);
  assert.deepEqual(config.stations, [station]);
  assert.equal(config.allowStationSwitch, false);
  assert.equal(config.resyncIntervalMs, 15000);
  assert.equal(config.requestTimeoutMs, 2500);
  assert.equal(config.localFallback, false);
  assert.equal(config.useManifestDurations, false);
});

test('rifiuta una risposta HTTP non riuscita', async (t) => {
  mockConfig(t, jsonResponse({}, 503));
  await assert.rejects(loadConfig(), /config\.json \(HTTP 503\)/);
});

test('rifiuta JSON di configurazione non valido', async (t) => {
  mockConfig(t, { ok: true, status: 200, json: async () => { throw new SyntaxError(); } });
  await assert.rejects(loadConfig(), /non contiene JSON valido/);
});

test('rifiuta una configurazione che non è un oggetto', async (t) => {
  mockConfig(t, jsonResponse([]));
  await assert.rejects(loadConfig(), /deve contenere un oggetto JSON/);
});

test('rifiuta sorgenti orarie malformate o URL non HTTP', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], timeSources: {} }));
  await assert.rejects(loadConfig(), /deve essere una lista ordinata/);

  mockConfig(t, jsonResponse({
    stations: [station],
    timeSources: [{ name: 'Orologio', url: 'file:///clock.json' }],
  }));
  await assert.rejects(loadConfig(), /deve usare HTTP o HTTPS/);
});

test('valida metadati, URL e ID univoci delle stazioni', async (t) => {
  mockConfig(t, jsonResponse({ stations: [] }));
  await assert.rejects(loadConfig(), /almeno una stazione/);

  mockConfig(t, jsonResponse({ stations: [station, station] }));
  await assert.rejects(loadConfig(), /Identificativo duplicato/);

  mockConfig(t, jsonResponse({ stations: [{ ...station, name: '' }] }));
  await assert.rejects(loadConfig(), /richiede id, name, description, manifestUrl e timelineStartsAt/);

  mockConfig(t, jsonResponse({ stations: [{ ...station, timelineStartsAt: '2026-01-01T00:00:00' }] }));
  await assert.rejects(loadConfig(), /timelineStartsAt.*fuso orario/);

  mockConfig(t, jsonResponse({ stations: [station], allowStationSwitch: 'true' }));
  await assert.rejects(loadConfig(), /allowStationSwitch.*true o false/);
});

test('rifiuta un valore localFallback non booleano', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], localFallback: 'true' }));
  await assert.rejects(loadConfig(), /deve essere true o false/);
});

test('abilita le durate dichiarate e rifiuta un valore non booleano', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], useManifestDurations: true }));
  assert.equal((await loadConfig()).useManifestDurations, true);

  mockConfig(t, jsonResponse({ stations: [station], useManifestDurations: 'true' }));
  await assert.rejects(loadConfig(), /useManifestDurations.*true o false/);
});

test('valida e normalizza la ripetizione per stazione', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [{ ...station, repeat: true }],
  }));
  assert.equal((await loadConfig()).stations[0].repeat, true);

  mockConfig(t, jsonResponse({
    stations: [{ ...station, repeat: 'true' }],
  }));
  await assert.rejects(loadConfig(), /stations\[0\]\.repeat deve essere true o false/);
});
