const SAMPLES_PER_SOURCE = 10;
const MAX_CLOCK_SAMPLES = 32;
const MAX_SAMPLE_AGE_MS = 120_000;
const MAX_SLEW_RATE = 0.005;
const MIN_SLEW_DURATION_MS = 5000;

export function createClock({ sources = [], timeoutMs = 8000, localFallback = true }) {
  let anchor = null;
  let lastError = '';
  let sourceWarning = '';
  let activeSource = null;
  let usingFallbackSource = false;
  let lastSample = null;
  let recentSamples = [];
  let attempts = sources.map((source) => ({ ...source, state: 'pending', latencyMs: null, error: '' }));
  let synchronizationQueue = Promise.resolve();

  function now() {
    if (!anchor) return localFallback ? Date.now() : null;
    return estimateAt(performance.now());
  }

  function estimateAt(monotonicMs) {
    const elapsedMs = monotonicMs - anchor.monotonicMs;
    const progress = anchor.slewDurationMs > 0
      ? Math.min(1, Math.max(0, elapsedMs / anchor.slewDurationMs))
      : 0;
    return anchor.utcMs + elapsedMs + anchor.slewAmountMs * progress;
  }

  function synchronize() {
    return queueSynchronization(false);
  }

  function reset() {
    return queueSynchronization(true);
  }

  function queueSynchronization(forceReset) {
    const result = synchronizationQueue.then(() => synchronizeClock(forceReset));
    synchronizationQueue = result.catch(() => {});
    return result;
  }

  async function synchronizeClock(forceReset) {
    const failures = [];
    const currentAttempts = sources.map((source) => ({
      name: source.name,
      url: source.url,
      state: 'pending',
      latencyMs: null,
      error: '',
    }));
    attempts = currentAttempts;
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index];
      try {
        const sourceStart = performance.now();
        const samples = [];
        let sampleError = '';
        for (let sampleIndex = 0; sampleIndex < SAMPLES_PER_SOURCE; sampleIndex += 1) {
          const remainingTimeoutMs = timeoutMs - (performance.now() - sourceStart);
          if (remainingTimeoutMs <= 0) {
            sampleError = 'timeout della richiesta.';
            break;
          }
          try {
            samples.push(await requestTime(source, Math.max(1, Math.floor(remainingTimeoutMs))));
          } catch (error) {
            sampleError = error.message;
            break;
          }
        }
        if (samples.length === 0) throw new Error(sampleError || 'nessun campione valido.');

        const sampleHistory = forceReset || activeSource !== source.name ? [] : recentSamples;
        const collectionTime = performance.now();
        const nextSamples = sampleHistory.filter((candidate) => (
          collectionTime - candidate.requestEnd <= MAX_SAMPLE_AGE_MS
        ));
        nextSamples.push(...samples);
        const selectedSamples = nextSamples.slice(-MAX_CLOCK_SAMPLES);

        const sample = selectedSamples.reduce((best, candidate) => (
          candidate.requestDurationMs < best.requestDurationMs ? candidate : best
        ));
        currentAttempts[index] = {
          ...currentAttempts[index],
          state: 'ok',
          latencyMs: sample.requestDurationMs,
          sampleCount: selectedSamples.length,
          error: '',
        };
        for (let nextIndex = index + 1; nextIndex < currentAttempts.length; nextIndex += 1) {
          currentAttempts[nextIndex].state = 'skipped';
        }
        attempts = currentAttempts;
        const anchorMonotonicMs = performance.now();
        const anchorWallClockMs = Date.now();
        const targetUtcMs = sample.utcMs + (anchorMonotonicMs - sample.midpoint);
        const currentUtcMs = anchor && !forceReset ? estimateAt(anchorMonotonicMs) : targetUtcMs;
        const slewAmountMs = anchor && !forceReset ? targetUtcMs - currentUtcMs : 0;
        recentSamples = selectedSamples;
        anchor = {
          utcMs: currentUtcMs,
          monotonicMs: anchorMonotonicMs,
          slewAmountMs,
          slewDurationMs: anchor && !forceReset
            ? Math.max(MIN_SLEW_DURATION_MS, Math.abs(slewAmountMs) / MAX_SLEW_RATE)
            : 0,
          uncertaintyMs: (sample.requestEnd - sample.requestStart) / 2,
          synchronizedAt: anchorWallClockMs,
        };
        lastSample = {
          utcMs: sample.utcMs,
          latencyMs: sample.requestDurationMs,
          httpStatus: sample.httpStatus,
          sampleCount: selectedSamples.length,
        };
        activeSource = source.name;
        usingFallbackSource = index > 0;
        if (sampleError) failures.push(`${source.name}: campionamento interrotto (${sampleError})`);
        sourceWarning = failures.join(' ');
        lastError = '';
        return status();
      } catch (error) {
        failures.push(`${source.name}: ${error.message}`);
        currentAttempts[index] = {
          ...currentAttempts[index],
          state: 'error',
          latencyMs: null,
          error: error.message,
        };
        attempts = currentAttempts;
      }
    }

    sourceWarning = '';
    lastError = failures.length
      ? `Nessuna sorgente dell’ora disponibile. ${failures.join(' ')}`
      : 'Nessuna API dell’ora configurata in timeSources.';
    throw new Error(lastError);
  }

  function status() {
    if (!anchor) {
      return {
        synchronized: false,
        fallback: localFallback,
        error: lastError,
        source: null,
        sourceWarning: '',
        attempts,
        lastSample: null,
        offsetMs: null,
        uncertaintyMs: null,
      };
    }
    return {
      synchronized: true,
      fallback: false,
      error: lastError,
      source: activeSource,
      usingFallbackSource,
      sourceWarning,
      attempts,
      lastSample,
      offsetMs: estimateAt(performance.now()) - Date.now(),
      uncertaintyMs: anchor.uncertaintyMs,
      synchronizedAt: anchor.synchronizedAt,
    };
  }

  return { now, synchronize, reset, status };
}

function readPath(value, path) {
  if (path === '') return value;
  return path.split('.').reduce((current, key) => current?.[key], value);
}

async function requestTime(source, timeoutMs) {
  const requestStart = performance.now();
  let response;
  try {
    response = await fetch(source.url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('timeout della richiesta.');
    throw new Error('servizio irraggiungibile o CORS non consentito.');
  }
  if (!response.ok) throw new Error(`servizio non disponibile (HTTP ${response.status}).`);

  let payload;
  if (source.responseFormat === 'text') {
    payload = parseTextFields(await response.text());
  } else {
    try {
      payload = await response.json();
    } catch {
      throw new Error('la risposta non contiene JSON valido.');
    }
  }
  const requestEnd = performance.now();
  const rawTime = readPath(payload, source.responsePath);
  const responseZone = source.timeZonePath ? readPath(payload, source.timeZonePath) : '';
  const utcMs = source.responseFormat === 'text' && isUnixSeconds(rawTime)
    ? Number(rawTime) * 1000
    : parseUtcTimestamp(rawTime, responseZone);
  if (!Number.isFinite(utcMs)) {
    throw new Error('timestamp UTC mancante o non valido. Controlla responsePath e timeZonePath.');
  }

  return {
    utcMs,
    requestStart,
    requestEnd,
    midpoint: (requestStart + requestEnd) / 2,
    requestDurationMs: requestEnd - requestStart,
    httpStatus: response.status,
  };
}

function parseTextFields(value) {
  return Object.fromEntries(value.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf('=');
    return separator > 0
      ? [[line.slice(0, separator).trim(), line.slice(separator + 1).trim()]]
      : [];
  }));
}

function isUnixSeconds(value) {
  return typeof value === 'string' && /^\d{10}(?:\.\d+)?$/.test(value);
}

function parseUtcTimestamp(value, zone) {
  if (typeof value !== 'string') return NaN;
  if (hasTimezone(value)) return Date.parse(value);

  const utcZones = ['utc', 'etc/utc', 'gmt', 'z', '+00:00'];
  if (!utcZones.includes(String(zone).toLowerCase())) return NaN;
  return Date.parse(`${value}Z`);
}

function hasTimezone(value) {
  return /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}