import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createClock } from '../src/clock.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => payload,
  };
}

function source(name, url, responsePath = 'utc', timeZonePath = '', responseFormat = 'json') {
  return { name, url, responsePath, timeZonePath, responseFormat };
}

test('sincronizza dal provider primario e stima il tempo con l’orologio monotono', async (t) => {
  const timestamp = new Date().toISOString();
  t.mock.method(globalThis, 'fetch', async () => response({ utc: timestamp }));
  const clock = createClock({
    sources: [source('Primario', 'https://primary.example/time')],
  });

  const status = await clock.synchronize();

  assert.equal(status.synchronized, true);
  assert.equal(status.source, 'Primario');
  assert.equal(status.attempts[0].state, 'ok');
  assert.equal(status.lastSample.httpStatus, 200);
  assert.ok(Number.isFinite(clock.now()));
  assert.ok(Math.abs(clock.now() - Date.parse(timestamp)) < 1000);
});

test('sceglie il campione con RTT minimo tra le misure dello stesso provider', async (t) => {
  let monotonicMs = 0;
  const durations = [80, 10, 40, 30, 20, 70, 60, 50, 40, 30];
  let requestIndex = 0;
  const timestamp = new Date().toISOString();
  t.mock.method(performance, 'now', () => monotonicMs);
  t.mock.method(globalThis, 'fetch', async () => {
    monotonicMs += durations[requestIndex++];
    return response({ utc: timestamp });
  });
  const clock = createClock({
    sources: [source('Primario', 'https://primary.example/time')],
  });

  const status = await clock.synchronize();

  assert.equal(requestIndex, 10);
  assert.equal(status.attempts[0].sampleCount, 10);
  assert.equal(status.lastSample.sampleCount, 10);
  assert.equal(status.lastSample.latencyMs, 10);
  assert.equal(status.uncertaintyMs, 5);
});

test('riusa il minimo RTT recente e scarta le misure scadute', async (t) => {
  let monotonicMs = 0;
  const durations = [
    80, 10, 40, 30, 20, 80, 90, 100, 110, 120,
    70, 60, 50, 40, 30, 80, 90, 100, 110, 120,
    70, 60, 50, 40, 30, 80, 90, 100, 110, 120,
  ];
  let requestIndex = 0;
  t.mock.method(performance, 'now', () => monotonicMs);
  t.mock.method(globalThis, 'fetch', async () => {
    monotonicMs += durations[requestIndex++];
    return response({ utc: '2026-01-01T00:00:00.000Z' });
  });
  const clock = createClock({
    sources: [source('Primario', 'https://primary.example/time')],
  });

  const firstStatus = await clock.synchronize();
  const secondStatus = await clock.synchronize();

  assert.equal(firstStatus.lastSample.sampleCount, 10);
  assert.equal(secondStatus.lastSample.sampleCount, 20);
  assert.equal(secondStatus.lastSample.latencyMs, 10);

  monotonicMs += 120_001;
  const expiredStatus = await clock.synchronize();

  assert.equal(expiredStatus.lastSample.sampleCount, 10);
  assert.equal(expiredStatus.lastSample.latencyMs, 30);
});

test('corregge gradualmente offset positivi e negativi senza salti nel clock', async (t) => {
  const wallClockBase = Date.now();
  let monotonicMs = 0;
  const durations = [
    20, 19, 18, 17, 16, 15, 14, 13, 12, 11,
    10, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05,
  ];
  let requestIndex = 0;
  t.mock.method(performance, 'now', () => monotonicMs);
  t.mock.method(Date, 'now', () => wallClockBase + monotonicMs);
  t.mock.method(globalThis, 'fetch', async () => {
    const requestStart = monotonicMs;
    const durationMs = durations[requestIndex];
    requestIndex += 1;
    monotonicMs += durationMs;
    const batchIndex = Math.floor((requestIndex - 1) / 10);
    const providerOffsetMs = batchIndex === 1 ? 100 : 0;
    const serverTime = wallClockBase + (requestStart + monotonicMs) / 2 + providerOffsetMs;
    return response({ utc: new Date(serverTime).toISOString() });
  });
  const clock = createClock({
    sources: [source('Primario', 'https://primary.example/time')],
  });

  await clock.synchronize();
  const initialTime = clock.now();
  const positiveSyncStart = monotonicMs;
  const beforePositiveCorrection = clock.now();
  await clock.synchronize();
  const afterPositiveCorrection = clock.now();

  assert.ok(Math.abs(afterPositiveCorrection - beforePositiveCorrection - (monotonicMs - positiveSyncStart)) < 1);
  monotonicMs += 10_000;
  const halfwayAfterPositiveCorrection = clock.now();
  assert.ok(Math.abs(halfwayAfterPositiveCorrection - afterPositiveCorrection - 10_050) < 2);

  monotonicMs += 10_000;
  const negativeSyncStart = monotonicMs;
  const beforeNegativeCorrection = clock.now();
  await clock.synchronize();
  const afterNegativeCorrection = clock.now();

  assert.ok(Math.abs(afterNegativeCorrection - beforeNegativeCorrection - (monotonicMs - negativeSyncStart)) < 1);
  monotonicMs += 10_000;
  const halfwayAfterNegativeCorrection = clock.now();
  assert.ok(halfwayAfterNegativeCorrection > afterNegativeCorrection);
  assert.ok(Math.abs(halfwayAfterNegativeCorrection - afterNegativeCorrection - 9950) < 2);
});

test('usa dieci campioni sia alla prima sincronizzazione sia al reset manuale', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return response({ utc: new Date().toISOString() });
  });
  const clock = createClock({
    sources: [source('Primario', 'https://primary.example/time')],
  });

  const initialStatus = await clock.synchronize();
  assert.equal(requests, 10);
  assert.equal(initialStatus.lastSample.sampleCount, 10);

  const resetStatus = await clock.reset();
  assert.equal(requests, 20);
  assert.equal(resetStatus.lastSample.sampleCount, 10);
});

test('usa il provider successivo quando il primario fallisce', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('primary')) return response({}, 502);
    return response({ utc: new Date().toISOString() });
  });
  const clock = createClock({
    sources: [
      source('Primario', 'https://primary.example/time'),
      source('Secondario', 'https://secondary.example/time'),
      source('Terziario', 'https://tertiary.example/time'),
    ],
  });

  const status = await clock.synchronize();

  assert.equal(status.source, 'Secondario');
  assert.equal(status.usingFallbackSource, true);
  assert.equal(status.attempts[0].state, 'error');
  assert.equal(status.attempts[1].state, 'ok');
  assert.equal(status.attempts[2].state, 'skipped');
  assert.match(status.sourceWarning, /Primario.*HTTP 502/);
});

test('legge il timestamp Unix in secondi da una risposta testuale', async (t) => {
  const timestamp = Date.now();
  t.mock.method(globalThis, 'fetch', async () => response(`ts=${timestamp / 1000}\ncolo=AMS\n`));
  const clock = createClock({
    sources: [source('Cloudflare', 'https://cloudflare.example/trace', 'ts', '', 'text')],
  });

  const status = await clock.synchronize();

  assert.equal(status.source, 'Cloudflare');
  assert.equal(status.attempts[0].state, 'ok');
  assert.ok(Math.abs(clock.now() - timestamp) < 1000);
});

test('interpreta un timestamp senza offset solo con zona UTC esplicita', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({
    time: '2026-01-01T00:00:00',
    zone: 'Etc/UTC',
  }));
  const clock = createClock({
    sources: [source('UTC', 'https://time.example/api', 'time', 'zone')],
    localFallback: false,
  });

  await clock.synchronize();
  assert.ok(Math.abs(clock.now() - Date.parse('2026-01-01T00:00:00Z')) < 1);
});

test('non accetta timestamp senza fuso se il provider dichiara una zona locale', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response({
    time: '2026-01-01T00:00:00',
    zone: 'Europe/Rome',
  }));
  const clock = createClock({
    sources: [source('Locale', 'https://time.example/api', 'time', 'zone')],
    localFallback: false,
  });

  await assert.rejects(clock.synchronize(), /timestamp UTC mancante o non valido/);
  assert.equal(clock.now(), null);
  assert.equal(clock.status().synchronized, false);
  assert.equal(clock.status().attempts[0].state, 'error');
});

test('mantiene l’ultimo campione valido se una risincronizzazione fallisce', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    if (requests === 1) return response({ utc: new Date().toISOString() });
    throw new TypeError('offline');
  });
  const clock = createClock({
    sources: [source('Primario', 'https://primary.example/time')],
    localFallback: false,
  });

  await clock.synchronize();
  const previousTime = clock.now();
  await assert.rejects(clock.synchronize(), /Nessuna sorgente/);

  assert.ok(clock.now() >= previousTime);
  assert.equal(clock.status().synchronized, true);
  assert.match(clock.status().error, /Nessuna sorgente/);
});

test('applica il fallback locale solo quando abilitato', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  const clock = createClock({
    sources: [source('Offline', 'https://offline.example/time')],
    localFallback: true,
  });
  const before = Date.now();

  await assert.rejects(clock.synchronize(), /Nessuna sorgente/);
  assert.equal(clock.status().fallback, true);
  assert.ok(clock.now() >= before);
});

test('segnala errore e tempo nullo quando non ci sono sorgenti e il fallback è disabilitato', async () => {
  const clock = createClock({ sources: [], localFallback: false });

  await assert.rejects(clock.synchronize(), /Nessuna API dell’ora configurata/);
  assert.equal(clock.now(), null);
  assert.equal(clock.status().fallback, false);
});

test('azzera subito la correzione dell’orologio e usa solo campioni nuovi', async (t) => {
  const wallClockBase = Date.now();
  let monotonicMs = 0;
  let serverUtcMs = wallClockBase;
  t.mock.method(performance, 'now', () => monotonicMs);
  t.mock.method(Date, 'now', () => wallClockBase + monotonicMs);
  t.mock.method(globalThis, 'fetch', async () => response({ utc: new Date(serverUtcMs).toISOString() }));
  const clock = createClock({
    sources: [source('Primario', 'https://primary.example/time')],
    localFallback: false,
  });

  await clock.synchronize();
  monotonicMs += 10_000;
  serverUtcMs = wallClockBase + 50_000;
  await clock.synchronize();
  const timeBeforeReset = clock.now();

  serverUtcMs = wallClockBase + 100_000;
  const status = await clock.reset();

  assert.ok(clock.now() - timeBeforeReset > 40_000);
  assert.equal(status.lastSample.sampleCount, 10);
});
