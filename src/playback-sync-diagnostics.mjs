const DEFAULT_WINDOW_MS = 60_000;

export function createPlaybackSyncDiagnostics({
  monotonicNow = () => performance.now(),
  windowMs = DEFAULT_WINDOW_MS,
} = {}) {
  let lastCheckAt = null;
  let checks = [];
  let firstCheck = 0;
  let driftSamples = [];
  let firstDriftSample = 0;

  function prune(now) {
    const cutoff = now - windowMs;
    while (firstCheck < checks.length && checks[firstCheck].at < cutoff) firstCheck += 1;
    while (firstDriftSample < driftSamples.length && driftSamples[firstDriftSample].at < cutoff) {
      firstDriftSample += 1;
    }
    if (firstCheck > 100 && firstCheck * 2 > checks.length) {
      checks = checks.slice(firstCheck);
      firstCheck = 0;
    }
    if (firstDriftSample > 100 && firstDriftSample * 2 > driftSamples.length) {
      driftSamples = driftSamples.slice(firstDriftSample);
      firstDriftSample = 0;
    }
  }

  return {
    reset() {
      lastCheckAt = null;
      checks = [];
      firstCheck = 0;
      driftSamples = [];
      firstDriftSample = 0;
    },
    recordCheck() {
      const at = monotonicNow();
      const intervalMs = lastCheckAt === null ? null : at - lastCheckAt;
      lastCheckAt = at;
      prune(at);
      checks.push({ at, intervalMs });
    },
    recordDrift({ driftMs, corrected }) {
      const at = monotonicNow();
      prune(at);
      driftSamples.push({ at, absoluteDriftMs: Math.abs(driftMs), corrected });
    },
    getState(configuredIntervalMs) {
      const now = monotonicNow();
      prune(now);
      const recentChecks = checks.slice(firstCheck);
      const recentDriftSamples = driftSamples.slice(firstDriftSample);
      const intervals = recentChecks
        .map(({ intervalMs }) => intervalMs)
        .filter((intervalMs) => intervalMs !== null);
      const absoluteDrifts = recentDriftSamples.map(({ absoluteDriftMs }) => absoluteDriftMs);

      return {
        configuredIntervalMs,
        checkCount: recentChecks.length,
        averageIntervalMs: intervals.length
          ? intervals.reduce((sum, intervalMs) => sum + intervalMs, 0) / intervals.length
          : null,
        driftSampleCount: recentDriftSamples.length,
        correctionCount: recentDriftSamples.filter(({ corrected }) => corrected).length,
        averageAbsoluteDriftMs: absoluteDrifts.length
          ? absoluteDrifts.reduce((sum, driftMs) => sum + driftMs, 0) / absoluteDrifts.length
          : null,
        maxAbsoluteDriftMs: absoluteDrifts.length ? Math.max(...absoluteDrifts) : null,
        windowMs,
      };
    },
  };
}
