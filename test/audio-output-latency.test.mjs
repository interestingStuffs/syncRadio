import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAudioOutputLatencyMonitor,
  MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS,
} from '../src/audio-output-latency.mjs';

function makeContext({ outputLatency = 0.024, state = 'running', resumeError = null } = {}) {
  return class FakeAudioContext {
    constructor(options) {
      this.options = options;
      this.outputLatency = outputLatency;
      this.state = state;
      this.resumeCalls = 0;
    }

    async resume() {
      this.resumeCalls += 1;
      if (resumeError) throw resumeError;
      this.state = 'running';
    }
  };
}

test('misura e compensa la latenza d’uscita attendibile', async () => {
  const monitor = createAudioOutputLatencyMonitor({
    AudioContextConstructor: makeContext({ outputLatency: 0.0244 }),
  });

  const state = await monitor.measure();

  assert.equal(state.status, 'measured');
  assert.equal(state.latencyMs, 24);
  assert.equal(state.compensationMs, 24);
  assert.equal(monitor.getCompensationMs(), 24);
});

test('riprende il contesto sospeso prima di leggere la latenza', async () => {
  let context;
  class SuspendedContext extends makeContext({ state: 'suspended' }) {
    constructor(options) {
      super(options);
      context = this;
    }
  }
  const monitor = createAudioOutputLatencyMonitor({ AudioContextConstructor: SuspendedContext });

  await monitor.measure();

  assert.equal(context.resumeCalls, 1);
  assert.equal(context.options.latencyHint, 'interactive');
  assert.equal(monitor.getCompensationMs(), 24);
});

test('ignora misure superiori alla soglia attendibile', async () => {
  const monitor = createAudioOutputLatencyMonitor({
    AudioContextConstructor: makeContext({
      outputLatency: (MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS + 1) / 1000,
    }),
  });

  const state = await monitor.measure();

  assert.equal(state.status, 'ignored');
  assert.equal(state.compensationMs, 0);
});

test('espone il mancato supporto senza interrompere la riproduzione', async () => {
  const monitor = createAudioOutputLatencyMonitor({ AudioContextConstructor: null });

  const state = await monitor.measure();

  assert.equal(state.status, 'unsupported');
  assert.equal(state.compensationMs, 0);
  assert.match(state.message, /non supporta AudioContext/);
});

test('espone gli errori di resume e mantiene la compensazione disattivata', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const monitor = createAudioOutputLatencyMonitor({
    AudioContextConstructor: makeContext({ state: 'suspended', resumeError: new Error('resume failed') }),
  });

  const state = await monitor.measure();

  assert.equal(state.status, 'error');
  assert.equal(state.compensationMs, 0);
});
