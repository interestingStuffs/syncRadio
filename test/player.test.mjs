import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudioPlayer } from '../src/player.mjs';

const contexts = [];

class FakeBufferSource {
  constructor(context) {
    this.context = context;
    this.buffer = null;
    this.started = null;
    this.stoppedAt = null;
    this.onended = null;
  }

  connect(destination) { this.destination = destination; }

  start(when, offset) {
    this.started = { when, offset };
  }

  stop(when) {
    this.stoppedAt = when;
  }

  finish() {
    this.onended?.();
  }
}

class FakeAudioContext {
  constructor(options) {
    this.options = options;
    this.state = 'running';
    this.currentTime = 10;
    this.destination = {};
    this.sources = [];
    this.decoded = 0;
    contexts.push(this);
  }

  createGain() {
    return { gain: { value: 1 }, connect(destination) { this.destination = destination; } };
  }

  createBufferSource() {
    const source = new FakeBufferSource(this);
    this.sources.push(source);
    return source;
  }

  async decodeAudioData() {
    this.decoded += 1;
    return { duration: 10 };
  }

  async resume() {
    this.state = 'running';
  }
}

function track(id = 'one', audioUrl = `https://audio.example/${id}.mp3`) {
  return { id, audioUrl };
}

function makePlayer(options = {}) {
  let monotonicMs = 0;
  const fetchCalls = [];
  const contextIndex = contexts.length;
  const player = createAudioPlayer({
    AudioContextConstructor: FakeAudioContext,
    fetchAudio: async (url) => {
      fetchCalls.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
    monotonicNow: () => monotonicMs,
    ...options,
  });
  return {
    player,
    fetchCalls,
    now(value) { monotonicMs = value; },
    get context() { return contexts[contextIndex]; },
  };
}

test('carica, decodifica e programma l’avvio con AudioContext', async () => {
  const setup = makePlayer();

  await setup.player.tune(track(), 2500);
  const { context } = setup;

  assert.deepEqual(setup.fetchCalls, ['https://audio.example/one.mp3']);
  assert.equal(context.options.latencyHint, 'interactive');
  assert.equal(context.decoded, 1);
  assert.equal(context.sources[0].started.when, 10.02);
  assert.equal(context.sources[0].started.offset, 2.52);
  assert.equal(setup.player.isPlaying(), true);
});

test('precarica e riutilizza il buffer decodificato al cambio traccia', async () => {
  const setup = makePlayer();

  await setup.player.tune(track('one'), 0);
  await setup.player.preload(track('two'));
  await setup.player.tune(track('two'), 2500);
  const { context } = setup;

  assert.deepEqual(setup.fetchCalls, [
    'https://audio.example/one.mp3',
    'https://audio.example/two.mp3',
  ]);
  assert.equal(context.decoded, 2);
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0].stoppedAt, context.currentTime);
  assert.equal(context.sources[1].started.offset, 2.52);
  assert.equal(setup.player.isPlaying(), true);
});

test('riusa la traccia selezionata quando la posizione segue la timeline', async () => {
  const setup = makePlayer();
  await setup.player.tune(track(), 1000);
  const { player, context, fetchCalls } = setup;

  setup.now(1000);
  context.currentTime = 11;
  player.sync(track(), 2000);

  assert.equal(context.sources.length, 1);
  assert.equal(fetchCalls.length, 1);
});

test('corregge gli scarti oltre 10 ms riprogrammando la sorgente', async () => {
  const measurements = [];
  const setup = makePlayer({ onSyncMeasurement: (measurement) => measurements.push(measurement) });
  await setup.player.tune(track(), 1000);
  const { player, context } = setup;

  setup.now(1000);
  context.currentTime = 11.05;
  player.sync(track(), 2000);
  await Promise.resolve();

  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0].stoppedAt, 11.07);
  assert.equal(context.sources[1].started.offset, 2.02);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].corrected, true);
  assert.ok(Math.abs(measurements[0].driftMs - 50) < 1e-9);
});

test('registra lo scarto senza riprogrammare quando resta entro la tolleranza', async () => {
  const measurements = [];
  const setup = makePlayer({ onSyncMeasurement: (measurement) => measurements.push(measurement) });
  await setup.player.tune(track(), 1000);
  const { player, context } = setup;

  setup.now(1000);
  context.currentTime = 11.005;
  player.sync(track(), 2000);

  assert.equal(context.sources.length, 1);
  assert.equal(measurements.length, 1);
  assert.equal(measurements[0].corrected, false);
  assert.ok(Math.abs(measurements[0].driftMs) <= 10);
});

test('riallinea su richiesta senza cambiare sorgente audio', async () => {
  const setup = makePlayer();
  await setup.player.tune(track(), 1000);
  const { player, context } = setup;
  const initialSource = context.sources[0];

  await player.realign(track(), 2000);

  assert.equal(context.sources.length, 2);
  assert.equal(initialSource.stoppedAt, context.sources[1].started.when);
  assert.equal(context.sources[1].started.offset, 2.02);
  assert.equal(player.isPlaying(), true);
});

test('cambia URL anche quando due stazioni riutilizzano lo stesso ID', async () => {
  const setup = makePlayer();

  await setup.player.tune(track(), 0);
  await setup.player.tune(track('one', 'https://another.example/one.mp3'), 0);

  assert.deepEqual(setup.fetchCalls, [
    'https://audio.example/one.mp3',
    'https://another.example/one.mp3',
  ]);
  assert.equal(setup.context.sources.length, 2);
});

test('riparte dalla posizione richiesta dopo la fine anticipata di una sorgente', async () => {
  const setup = makePlayer();
  await setup.player.tune(track(), 0);
  const { player, context } = setup;
  context.sources[0].finish();

  setup.now(500);
  player.sync(track(), 500);
  await Promise.resolve();

  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[1].started.offset, 0.52);
  assert.equal(player.isPlaying(), true);
});

test('non avvia una traccia quando una richiesta più recente la sostituisce', async () => {
  let resolveFirstFetch;
  const setup = makePlayer({
    fetchAudio: (url) => {
      if (url.includes('/one.mp3')) {
        return new Promise((resolve) => { resolveFirstFetch = () => resolve({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(8),
        }); });
      }
      return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    },
  });
  setup.player.sync(track(), 1000);
  setup.player.sync(track('two'), 2000);
  await Promise.resolve();
  resolveFirstFetch();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(setup.context.sources.length, 1);
  assert.equal(setup.context.sources[0].started.offset, 2.02);
});

test('propaga errori HTTP e interrompe la riproduzione pendente', async () => {
  const setup = makePlayer({
    fetchAudio: async () => ({ ok: false, status: 404 }),
  });

  await assert.rejects(setup.player.tune(track(), 0), /HTTP 404/);
  setup.player.pause();
  assert.equal(setup.player.isPlaying(), false);
});

test('ritenta il caricamento dopo un errore HTTP temporaneo', async () => {
  let attempts = 0;
  const setup = makePlayer({
    fetchAudio: async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, status: 503 }
        : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
  });

  await assert.rejects(setup.player.tune(track(), 0), /HTTP 503/);
  await setup.player.tune(track(), 0);

  assert.equal(attempts, 2);
  assert.equal(setup.player.isPlaying(), true);
});

test('applica i limiti al volume e commuta mute conservando il volume', () => {
  const { player } = makePlayer();

  player.setVolume(-1);
  player.toggleMute();
  player.setVolume(0.35);
  assert.equal(player.isMuted(), false);
  player.setVolume(2);
  assert.equal(player.isMuted(), false);
});

test('mantiene volume e mute nel nodo gain dopo la creazione del contesto', async () => {
  const setup = makePlayer();

  setup.player.setVolume(0.35);
  setup.player.toggleMute();
  await setup.player.tune(track(), 0);
  const { context } = setup;

  assert.equal(context.sources[0].destination.destination, context.destination);
  assert.equal(setup.player.isMuted(), true);
  assert.equal(context.sources[0].destination.gain.value, 0);
  setup.player.toggleMute();
  assert.equal(setup.player.isMuted(), false);
  assert.equal(context.sources[0].destination.gain.value, 0.35);
});

test('ferma la sorgente attiva quando la programmazione termina', async () => {
  const setup = makePlayer();

  await setup.player.tune(track(), 0);
  setup.player.sync(null, 0);
  const { context } = setup;

  assert.equal(context.sources[0].stoppedAt, context.currentTime);
  assert.equal(setup.player.isPlaying(), false);
});
