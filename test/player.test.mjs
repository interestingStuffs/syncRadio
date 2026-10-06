import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createAudioPlayer } from '../src/player.mjs';

const originalAudio = globalThis.Audio;
const originalMediaElement = globalThis.HTMLMediaElement;
const originalMediaError = globalThis.MediaError;
const instances = [];

class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.preload = '';
    this.src = '';
    this.duration = 10;
    this.currentTime = 0;
    this.seeking = false;
    this.readyState = 0;
    this.paused = true;
    this.playbackRate = 1;
    this.volume = 1;
    this.muted = false;
    this.error = null;
    this.loadCalls = 0;
    this.playCalls = 0;
    this.pauseCalls = 0;
    instances.push(this);
  }

  addEventListener(name, callback, options = {}) {
    const handlers = this.listeners.get(name) || [];
    handlers.push({ callback, once: Boolean(options.once) });
    this.listeners.set(name, handlers);
  }

  emit(name) {
    const handlers = this.listeners.get(name) || [];
    for (const handler of [...handlers]) {
      handler.callback();
      if (handler.once) handlers.splice(handlers.indexOf(handler), 1);
    }
  }

  finish() {
    this.paused = true;
    this.emit('ended');
  }

  load() { this.loadCalls += 1; }

  async play() {
    this.playCalls += 1;
    this.paused = false;
    this.emit('play');
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
    this.emit('pause');
  }

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
}

globalThis.Audio = FakeAudio;
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 };
globalThis.MediaError = { MEDIA_ERR_SRC_NOT_SUPPORTED: 4 };

after(() => {
  if (originalAudio === undefined) delete globalThis.Audio;
  else globalThis.Audio = originalAudio;
  if (originalMediaElement === undefined) delete globalThis.HTMLMediaElement;
  else globalThis.HTMLMediaElement = originalMediaElement;
  if (originalMediaError === undefined) delete globalThis.MediaError;
  else globalThis.MediaError = originalMediaError;
});

function track(id = 'one') {
  return { id, audioUrl: `https://audio.example/${id}.mp3` };
}

function makePlayer(options) {
  const player = createAudioPlayer(options);
  return { player, audio: instances.at(-1) };
}

test('sintonizza una traccia, carica il file e allinea l’offset dopo i metadati', async () => {
  const { player, audio } = makePlayer();

  await player.tune(track(), 2500);

  assert.equal(audio.src, 'https://audio.example/one.mp3');
  assert.equal(audio.preload, 'auto');
  assert.equal(audio.loadCalls, 1);
  assert.equal(audio.currentTime, 0);
  audio.readyState = 1;
  audio.emit('loadedmetadata');
  assert.ok(Math.abs(audio.currentTime - 2.5) <= 0.01);
  assert.equal(player.isPlaying(), true);
});

test('precarica la traccia successiva e riusa il media element al cambio', async () => {
  const { player, audio } = makePlayer();
  const initialInstanceCount = instances.length;

  await player.tune(track('one'), 0);
  audio.readyState = 1;
  audio.emit('loadedmetadata');
  player.preload(track('two'));
  const warmedAudio = instances.at(-1);
  warmedAudio.readyState = 1;

  assert.equal(warmedAudio.preload, 'auto');
  assert.equal(warmedAudio.src, 'https://audio.example/two.mp3');
  assert.equal(warmedAudio.loadCalls, 1);

  await player.tune(track('two'), 2500);

  assert.equal(instances.length, initialInstanceCount + 1);
  assert.equal(warmedAudio.loadCalls, 1);
  assert.ok(Math.abs(warmedAudio.currentTime - 2.5) <= 0.01);
  assert.equal(warmedAudio.paused, false);
  assert.equal(audio.paused, true);
});

test('riusa la traccia selezionata e riallinea l’offset richiesto', () => {
  const { player, audio } = makePlayer();

  player.sync(track(), 1000);
  audio.readyState = 1;
  audio.emit('loadedmetadata');
  player.sync(track(), 4000);

  assert.equal(audio.loadCalls, 1);
  assert.ok(Math.abs(audio.currentTime - 4) <= 0.01);
});

test('non cerca di nuovo durante la riproduzione, ma riallinea dopo un’interruzione', async () => {
  const { player, audio } = makePlayer();

  await player.tune(track(), 1000);
  audio.readyState = 1;
  audio.emit('loadedmetadata');
  audio.currentTime = 2;

  player.sync(track(), 1500);
  assert.equal(audio.currentTime, 2);
  assert.equal(audio.playCalls, 1);

  audio.pause();
  player.sync(track(), 4000);
  assert.ok(Math.abs(audio.currentTime - 4) <= 0.01);
  assert.equal(audio.playCalls, 2);
  assert.equal(audio.paused, false);
});

test('corregge gli scarti superiori a 10 ms e tollera quelli entro la soglia', () => {
  const { player, audio } = makePlayer();

  player.sync(track(), 1000);
  audio.readyState = 1;
  audio.emit('loadedmetadata');

  player.sync(track(), 1009);
  assert.ok(Math.abs(audio.currentTime - 1) <= 0.01);

  player.sync(track(), 1011);
  assert.ok(Math.abs(audio.currentTime - 1.011) <= 0.01);
});

test('riallinea su richiesta senza interrompere una traccia già in riproduzione', async () => {
  const { player, audio } = makePlayer();

  await player.tune(track(), 1000);
  audio.readyState = 1;
  audio.emit('loadedmetadata');
  audio.currentTime = 8;
  const previousPlayCalls = audio.playCalls;
  const previousPauseCalls = audio.pauseCalls;

  await player.realign(track(), 2000);

  assert.ok(Math.abs(audio.currentTime - 2) <= 0.01);
  assert.equal(audio.paused, false);
  assert.equal(audio.playCalls, previousPlayCalls);
  assert.equal(audio.pauseCalls, previousPauseCalls);
});

test('cambia sorgente per la traccia nuova e mette in pausa quando la scaletta finisce', () => {
  const { player, audio } = makePlayer();

  player.sync(track(), 0);
  player.sync(track('two'), 0);
  assert.equal(audio.src, 'https://audio.example/two.mp3');
  assert.equal(audio.loadCalls, 2);

  player.pause();
  player.sync(null, 0);
  assert.equal(audio.paused, true);
  assert.equal(audio.pauseCalls, 2);
});

test('ricarica il file se due stazioni usano lo stesso ID traccia', () => {
  const { player, audio } = makePlayer();

  player.sync(track(), 0);
  player.sync({ id: 'one', audioUrl: 'https://another.example/one.mp3' }, 0);

  assert.equal(audio.src, 'https://another.example/one.mp3');
  assert.equal(audio.loadCalls, 2);
});

test('riprende sulla traccia successiva se il file precedente termina in anticipo', async () => {
  const { player, audio } = makePlayer();

  await player.tune(track(), 0);
  audio.finish();
  player.sync(track(), 500);
  assert.equal(audio.playCalls, 1);

  player.sync(track('two'), 0);
  await Promise.resolve();
  assert.equal(audio.src, 'https://audio.example/two.mp3');
  assert.equal(audio.playCalls, 2);
});

test('riproduce la nuova traccia quando il cambio avviene durante una richiesta play pendente', async () => {
  const { player, audio } = makePlayer();
  let finishFirstPlay;
  audio.play = () => {
    audio.playCalls += 1;
    if (audio.playCalls === 1) {
      return new Promise((resolve) => { finishFirstPlay = resolve; });
    }
    audio.paused = false;
    return Promise.resolve();
  };

  const firstPlay = player.tune(track(), 1000);
  player.sync(track('two'), 2000);
  audio.readyState = 1;
  audio.emit('loadedmetadata');
  assert.equal(audio.playCalls, 1);

  finishFirstPlay();
  await firstPlay;
  await Promise.resolve();

  assert.equal(audio.src, 'https://audio.example/two.mp3');
  assert.equal(audio.playCalls, 2);
  assert.equal(audio.paused, false);
});

test('riavvia la stessa traccia a un nuovo ciclo di ripetizione', async () => {
  const { player, audio } = makePlayer();

  await player.tune(track(), 9000);
  audio.readyState = 1;
  audio.emit('loadedmetadata');
  audio.finish();
  player.sync(track(), 0, true);

  assert.equal(audio.src, 'https://audio.example/one.mp3');
  assert.equal(audio.loadCalls, 1);
  assert.equal(audio.playCalls, 2);
  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 0);
});

test('mantiene il playback durante sync e applica i limiti al volume', async () => {
  const { player, audio } = makePlayer();

  await player.tune(track(), 0);
  player.sync(track(), 500);
  assert.equal(audio.playCalls, 1);

  player.setVolume(-1);
  assert.equal(audio.volume, 0);
  player.setVolume(2);
  assert.equal(audio.volume, 1);
  player.setVolume(0.35);
  assert.equal(audio.volume, 0.35);
});

test('silenzia e ripristina l’audio senza perdere il volume impostato', () => {
  const { player, audio } = makePlayer();

  player.setVolume(0.35);
  player.toggleMute();
  assert.equal(player.isMuted(), true);
  assert.equal(audio.muted, true);
  assert.equal(audio.volume, 0.35);

  player.toggleMute();
  assert.equal(player.isMuted(), false);
  assert.equal(audio.muted, false);
  assert.equal(audio.volume, 0.35);
});

test('ripristina il volume precedente quando si riattiva dall’icona dopo volume zero', () => {
  const { player, audio } = makePlayer();

  player.setVolume(0.35);
  player.setVolume(0);
  assert.equal(player.isMuted(), true);
  player.toggleMute();
  assert.equal(audio.volume, 0.35);
  assert.equal(player.isMuted(), false);
});

test('notifica errori del media player con un messaggio leggibile', () => {
  const errors = [];
  const { audio } = makePlayer({ onError: (message) => errors.push(message) });

  audio.error = { code: 4 };
  audio.emit('error');
  assert.match(errors[0], /non supportato/);

  audio.error = { code: 2 };
  audio.emit('error');
  assert.match(errors[1], /non raggiungibile/);
});
