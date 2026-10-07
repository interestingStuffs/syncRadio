export const MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS = 100;

export function createAudioOutputLatencyMonitor({
  AudioContextConstructor = globalThis.AudioContext,
  maxCompensationMs = MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS,
} = {}) {
  if (!Number.isFinite(maxCompensationMs) || maxCompensationMs < 0) {
    throw new RangeError('maxCompensationMs deve essere un numero finito non negativo.');
  }

  let context = null;
  let measurement = null;
  let pendingCompensationMs = null;
  let candidateMessage = '';
  let state = {
    status: 'unmeasured',
    latencyMs: null,
    compensationMs: 0,
    pendingCompensationMs: null,
    message: 'La latenza di uscita non è ancora stata misurata.',
  };

  function getState() {
    return { ...state };
  }

  function measure() {
    if (measurement) return measurement;

    measurement = (async () => {
      if (typeof AudioContextConstructor !== 'function') {
        recordMeasurement({
          status: 'unsupported',
          latencyMs: null,
          compensationMs: 0,
          message: 'Il browser non supporta AudioContext; compensazione automatica non disponibile.',
        });
        return getState();
      }

      try {
        if (!context || context.state === 'closed') {
          context = new AudioContextConstructor({ latencyHint: 'interactive' });
        }
        if (context.state !== 'running') await context.resume();

        const outputLatencyMs = context.outputLatency * 1000;
        if (!Number.isFinite(outputLatencyMs) || outputLatencyMs < 0) {
          recordMeasurement({
            status: 'unsupported',
            latencyMs: null,
            compensationMs: 0,
            message: 'Il browser non espone una misura valida della latenza di uscita.',
          });
        } else if (outputLatencyMs > maxCompensationMs) {
          recordMeasurement({
            status: 'ignored',
            latencyMs: outputLatencyMs,
            compensationMs: 0,
            message: `Misura di ${Math.round(outputLatencyMs)} ms non compensata perché superiore al limite configurato di ${maxCompensationMs} ms.`,
          });
        } else {
          const latencyMs = Math.round(outputLatencyMs);
          recordMeasurement({
            status: 'measured',
            latencyMs,
            compensationMs: latencyMs,
            message: `Latenza stimata: ${latencyMs} ms. La pipeline HTML audio può avere buffering aggiuntivo.`,
          });
        }
      } catch (error) {
        console.warn('[AudioOutputLatency] Misurazione non riuscita:', error);
        pendingCompensationMs = null;
        state = {
          ...state,
          status: 'error',
          latencyMs: null,
          pendingCompensationMs: null,
          message: 'Misurazione della latenza di uscita non riuscita; compensazione attiva invariata.',
        };
      }

      return getState();
    })().finally(() => {
      measurement = null;
    });

    return measurement;
  }

  function recordMeasurement(candidate) {
    pendingCompensationMs = candidate.compensationMs;
    candidateMessage = candidate.message;
    state = {
      ...candidate,
      compensationMs: state.compensationMs,
      pendingCompensationMs,
      message: pendingCompensationMs === state.compensationMs
        ? `${candidate.message} Compensazione attiva: ${state.compensationMs} ms.`
        : `${candidate.message} Nuova compensazione in attesa di risincronizzazione.`,
    };
  }

  function applyMeasurement() {
    if (pendingCompensationMs === null) return getState();

    const compensationMs = pendingCompensationMs;
    pendingCompensationMs = null;
    state = {
      ...state,
      compensationMs,
      pendingCompensationMs: null,
      message: state.status === 'measured'
        ? `Latenza stimata: ${state.latencyMs} ms; compensazione applicata. La pipeline HTML audio può avere buffering aggiuntivo.`
        : `${candidateMessage} Compensazione attiva: ${compensationMs} ms.`,
    };
    return getState();
  }

  return {
    measure,
    applyMeasurement,
    getState,
    getCompensationMs: () => state.compensationMs,
  };
}
