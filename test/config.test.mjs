import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { loadConfig } from '../src/config.mjs';

const originalFetch = globalThis.fetch;
const station = {
  id: 'radio',
  name: 'Radio',
  description: 'Descrizione',
  timelineStartsAt: '2026-01-01T00:00:00Z',
  repeat: false,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockConfig(t, response, { defaultStationCatalogUrl = true } = {}) {
  t.mock.method(globalThis, 'fetch', async () => {
    if (!defaultStationCatalogUrl || !response.ok || typeof response.json !== 'function') return response;
    return {
      ...response,
      json: async () => {
        const config = await response.json();
        if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
        return { stationCatalogUrl: './stations.json', ...config };
      },
    };
  });
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
    stationCatalogUrl: '  ./catalog.json ',
    allowStationSwitch: true,
    timeSources: [{
      name: ' Orologio ',
      url: 'https://time.example/api',
      responsePath: 'data.utc',
      responseFormat: 'json',
    }],
  }));

  assert.deepEqual(await loadConfig(), {
    stationCatalogUrl: './catalog.json',
    allowStationSwitch: true,
    stationQueryParam: null,
    audioOffsetQueryParam: null,
    customTimeSourceOnly: false,
    resyncOnTrackChangeOnly: false,
    timeSources: [{
      name: 'Orologio',
      url: 'https://time.example/api',
      responsePath: 'data.utc',
      timeZonePath: '',
      responseFormat: 'json',
    }],
    resyncIntervalMs: 30000,
    requestTimeoutMs: 8000,
    maxOutputLatencyCompensationMs: 100,
    outputLatencyRefreshIntervalMs: 30000,
    enableOutputLatencyCompensation: true,
    playbackSyncIntervalMs: 50,
    localFallback: true,
    useManifestDurations: false,
    showPlaybackCalibration: true,
    showPlaybackOffsetControls: true,
    showSyncDiagnostics: true,
  });
});

test('accetta una lista vuota di sorgenti e fallback locale disattivato', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    timeSources: [],
    resyncIntervalMs: 15000,
    requestTimeoutMs: 2500,
    playbackSyncIntervalMs: 100,
    localFallback: false,
  }));

  const config = await loadConfig();
  assert.deepEqual(config.timeSources, []);
  assert.equal(config.stationCatalogUrl, './stations.json');
  assert.equal(config.allowStationSwitch, false);
  assert.equal(config.customTimeSourceOnly, false);
  assert.equal(config.resyncOnTrackChangeOnly, false);
  assert.equal(config.resyncIntervalMs, 15000);
  assert.equal(config.requestTimeoutMs, 2500);
  assert.equal(config.playbackSyncIntervalMs, 100);
  assert.equal(config.maxOutputLatencyCompensationMs, 100);
  assert.equal(config.outputLatencyRefreshIntervalMs, 30000);
  assert.equal(config.localFallback, false);
  assert.equal(config.useManifestDurations, false);
  assert.equal(config.showPlaybackCalibration, true);
});

test('carica i limiti configurati per la misura della latenza audio', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    maxOutputLatencyCompensationMs: 75,
    outputLatencyRefreshIntervalMs: 60000,
    enableOutputLatencyCompensation: false,
  }));

  const config = await loadConfig();
  assert.equal(config.maxOutputLatencyCompensationMs, 75);
  assert.equal(config.outputLatencyRefreshIntervalMs, 60000);
  assert.equal(config.enableOutputLatencyCompensation, false);
});

test('rifiuta un valore non booleano per enableOutputLatencyCompensation', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], enableOutputLatencyCompensation: 'false' }));
  await assert.rejects(loadConfig(), /enableOutputLatencyCompensation.*true o false/);
});

test('rifiuta limiti non validi per la latenza audio', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], maxOutputLatencyCompensationMs: -1 }));
  await assert.rejects(loadConfig(), /maxOutputLatencyCompensationMs.*tra 0 e 1000/);

  mockConfig(t, jsonResponse({ stations: [station], maxOutputLatencyCompensationMs: 1001 }));
  await assert.rejects(loadConfig(), /maxOutputLatencyCompensationMs.*tra 0 e 1000/);

  mockConfig(t, jsonResponse({ stations: [station], outputLatencyRefreshIntervalMs: 500 }));
  await assert.rejects(loadConfig(), /outputLatencyRefreshIntervalMs.*tra 1000 e/);
});

test('rifiuta intervalli non validi per il controllo audio', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], playbackSyncIntervalMs: 9 }));
  await assert.rejects(loadConfig(), /playbackSyncIntervalMs.*tra 10 e 1000/);

  mockConfig(t, jsonResponse({ stations: [station], playbackSyncIntervalMs: 1001 }));
  await assert.rejects(loadConfig(), /playbackSyncIntervalMs.*tra 10 e 1000/);

  mockConfig(t, jsonResponse({ stations: [station], playbackSyncIntervalMs: '50' }));
  await assert.rejects(loadConfig(), /playbackSyncIntervalMs.*tra 10 e 1000/);
});

test('abilita la risincronizzazione solo al cambio traccia', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    resyncOnTrackChangeOnly: true,
    resyncIntervalMs: 12000,
  }));

  const config = await loadConfig();

  assert.equal(config.resyncOnTrackChangeOnly, true);
  assert.equal(config.resyncIntervalMs, 12000);
});

test('rifiuta un valore non booleano per resyncOnTrackChangeOnly', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], resyncOnTrackChangeOnly: 'yes' }));
  await assert.rejects(loadConfig(), /resyncOnTrackChangeOnly.*true o false/);
});

test('disattiva il servizio orario proprietario finché l’URL è vuoto', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    customTimeSource: {
      name: 'SyncRadio · UTC',
      url: '  ',
      responsePath: 'utc',
    },
    timeSources: [{
      name: 'Pubblico',
      url: 'https://time.example/api',
      responsePath: 'utc',
    }],
  }));

  const config = await loadConfig();

  assert.deepEqual(config.timeSources, [{
    name: 'Pubblico',
    url: 'https://time.example/api',
    responsePath: 'utc',
    timeZonePath: '',
    responseFormat: 'json',
  }]);
});

test('prova il servizio orario proprietario per primo quando configurato', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    customTimeSource: {
      name: 'SyncRadio UTC',
      url: 'https://clock.syncradio.example/api/time',
      responsePath: 'data.utc',
    },
    timeSources: [{
      name: 'Pubblico',
      url: 'https://time.example/api',
      responsePath: 'utc',
    }],
  }));

  const config = await loadConfig();

  assert.equal(config.timeSources[0].name, 'SyncRadio UTC');
  assert.equal(config.timeSources[0].responsePath, 'data.utc');
  assert.deepEqual(config.timeSources.map(({ name }) => name), ['SyncRadio UTC', 'Pubblico']);
});

test('usa solo il servizio orario proprietario quando configurato in modalità esclusiva', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    customTimeSource: {
      name: 'Orologio LAN',
      url: 'http://192.168.1.20:8080/time',
      responsePath: 'utc',
    },
    customTimeSourceOnly: true,
    timeSources: [{
      name: 'Pubblico',
      url: 'https://time.example/api',
      responsePath: 'utc',
    }],
  }));

  const config = await loadConfig();

  assert.equal(config.customTimeSourceOnly, true);
  assert.deepEqual(config.timeSources.map(({ name }) => name), ['Orologio LAN']);
});

test('non usa sorgenti orarie pubbliche in modalità esclusiva senza URL personalizzato', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    customTimeSource: { url: '' },
    customTimeSourceOnly: true,
    timeSources: [{
      name: 'Pubblico',
      url: 'https://time.example/api',
      responsePath: 'utc',
    }],
  }));

  const config = await loadConfig();

  assert.equal(config.customTimeSourceOnly, true);
  assert.deepEqual(config.timeSources, []);
});

test('valida URL e formato del servizio orario proprietario anche se attivato', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    customTimeSource: { url: 'file:///clock.json' },
  }));
  await assert.rejects(loadConfig(), /customTimeSource\.url deve usare HTTP o HTTPS/);

  mockConfig(t, jsonResponse({
    stations: [station],
    customTimeSource: {
      url: 'https://clock.example/api',
      responseFormat: 'xml',
    },
  }));
  await assert.rejects(loadConfig(), /customTimeSource\.responseFormat deve essere "json" o "text"/);
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

test('rifiuta formati di risposta delle sorgenti orarie non supportati', async (t) => {
  mockConfig(t, jsonResponse({
    stations: [station],
    timeSources: [{
      name: 'Orologio',
      url: 'https://time.example/api',
      responsePath: 'utc',
      responseFormat: 'xml',
    }],
  }));
  await assert.rejects(loadConfig(), /responseFormat deve essere "json" o "text"/);
});

test('richiede un URL al catalogo delle stazioni', async (t) => {
  mockConfig(t, jsonResponse({}), { defaultStationCatalogUrl: false });
  await assert.rejects(loadConfig(), /richiede stationCatalogUrl/);

  mockConfig(t, jsonResponse({ stationCatalogUrl: '  ' }));
  await assert.rejects(loadConfig(), /richiede stationCatalogUrl/);

  mockConfig(t, jsonResponse({ stationCatalogUrl: 42 }));
  await assert.rejects(loadConfig(), /stationCatalogUrl.*deve essere una stringa/);

  mockConfig(t, jsonResponse({ stations: [station], allowStationSwitch: 'true' }));
  await assert.rejects(loadConfig(), /allowStationSwitch.*true o false/);
});

test('valida e normalizza il parametro URL per la selezione della stazione', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], stationQueryParam: '  radio  ' }));
  assert.equal((await loadConfig()).stationQueryParam, 'radio');

  mockConfig(t, jsonResponse({ stations: [station], stationQueryParam: '' }));
  await assert.rejects(loadConfig(), /stationQueryParam.*stringa non vuota/);

  mockConfig(t, jsonResponse({ stations: [station], stationQueryParam: 42 }));
  await assert.rejects(loadConfig(), /stationQueryParam.*deve essere una stringa/);
});

test('valida e normalizza il parametro URL per l’offset audio host', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], audioOffsetQueryParam: '  audioDelay  ' }));
  assert.equal((await loadConfig()).audioOffsetQueryParam, 'audioDelay');

  mockConfig(t, jsonResponse({ stations: [station], audioOffsetQueryParam: '' }));
  await assert.rejects(loadConfig(), /audioOffsetQueryParam.*stringa non vuota/);

  mockConfig(t, jsonResponse({ stations: [station], audioOffsetQueryParam: 42 }));
  await assert.rejects(loadConfig(), /audioOffsetQueryParam.*deve essere una stringa/);
});

test('ignora la vecchia configurazione del parametro URL per l’offset', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], playbackOffsetQueryParam: 'offset' }));
  assert.equal('playbackOffsetQueryParam' in await loadConfig(), false);
});

test('rifiuta un valore localFallback non booleano', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], localFallback: 'true' }));
  await assert.rejects(loadConfig(), /deve essere true o false/);
});

test('rifiuta un valore customTimeSourceOnly non booleano', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], customTimeSourceOnly: 'true' }));
  await assert.rejects(loadConfig(), /customTimeSourceOnly.*true o false/);
});

test('abilita le durate dichiarate e rifiuta un valore non booleano', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], useManifestDurations: true }));
  assert.equal((await loadConfig()).useManifestDurations, true);

  mockConfig(t, jsonResponse({ stations: [station], useManifestDurations: 'true' }));
  await assert.rejects(loadConfig(), /useManifestDurations.*true o false/);
});

test('configura la visibilità della calibrazione guidata', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], showPlaybackCalibration: false }));
  assert.equal((await loadConfig()).showPlaybackCalibration, false);

  mockConfig(t, jsonResponse({ stations: [station], showPlaybackCalibration: 'false' }));
  await assert.rejects(loadConfig(), /showPlaybackCalibration.*true o false/);
});

test('configura la visibilità dei comandi di offset manuale', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], showPlaybackOffsetControls: false }));
  assert.equal((await loadConfig()).showPlaybackOffsetControls, false);

  mockConfig(t, jsonResponse({ stations: [station], showPlaybackOffsetControls: 'false' }));
  await assert.rejects(loadConfig(), /showPlaybackOffsetControls.*true o false/);
});

test('configura la visibilità delle metriche di sincronizzazione', async (t) => {
  mockConfig(t, jsonResponse({ stations: [station], showSyncDiagnostics: false }));
  assert.equal((await loadConfig()).showSyncDiagnostics, false);

  mockConfig(t, jsonResponse({ stations: [station], showSyncDiagnostics: 'false' }));
  await assert.rejects(loadConfig(), /showSyncDiagnostics.*true o false/);
});
