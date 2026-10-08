import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlaybackSyncDiagnostics } from '../src/playback-sync-diagnostics.mjs';

test('riassume intervallo dei controlli e scarti nella finestra recente', () => {
  let now = 0;
  const diagnostics = createPlaybackSyncDiagnostics({
    monotonicNow: () => now,
    windowMs: 1000,
  });

  diagnostics.recordCheck();
  now = 50;
  diagnostics.recordCheck();
  diagnostics.recordDrift({ driftMs: -4, corrected: false });
  now = 100;
  diagnostics.recordCheck();
  diagnostics.recordDrift({ driftMs: 12, corrected: true });

  assert.deepEqual(diagnostics.getState(50), {
    configuredIntervalMs: 50,
    checkCount: 3,
    averageIntervalMs: 50,
    driftSampleCount: 2,
    correctionCount: 1,
    averageAbsoluteDriftMs: 8,
    maxAbsoluteDriftMs: 12,
    windowMs: 1000,
  });
});

test('rimuove le misure fuori dalla finestra e azzera lo storico', () => {
  let now = 0;
  const diagnostics = createPlaybackSyncDiagnostics({
    monotonicNow: () => now,
    windowMs: 100,
  });

  diagnostics.recordCheck();
  diagnostics.recordDrift({ driftMs: 20, corrected: true });
  now = 101;
  assert.deepEqual(diagnostics.getState(200), {
    configuredIntervalMs: 200,
    checkCount: 0,
    averageIntervalMs: null,
    driftSampleCount: 0,
    correctionCount: 0,
    averageAbsoluteDriftMs: null,
    maxAbsoluteDriftMs: null,
    windowMs: 100,
  });

  diagnostics.recordCheck();
  diagnostics.reset();
  assert.equal(diagnostics.getState(200).checkCount, 0);
});
