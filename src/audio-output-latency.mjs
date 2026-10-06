export const MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS = 100;

export function createAudioOutputLatencyMonitor({
  AudioContextConstructor = globalThis.AudioContext,
} = {}) {
  let context = null;
  let measurement = null;
  let state = {
    status: 'unmeasured',
    latencyMs: null,
    compensationMs: 0,
    message: 'La latenza di uscita non è ancora stata misurata.',
  };

  function getState() {
    return { ...state };
  }

  function measure() {
    if (measurement) return measurement;

    measurement = (async () => {
      if (typeof AudioContextConstructor !== 'function') {
        state = {
          status: 'unsupported',
          latencyMs: null,
          compensationMs: 0,
          message: 'Il browser non supporta AudioContext; compensazione automatica non disponibile.',
        };
        return getState();
      }

      try {
        if (!context || context.state === 'closed') {
          context = new AudioContextConstructor({ latencyHint: 'interactive' });
        }
        if (context.state !== 'running') await context.resume();

        const outputLatencyMs = context.outputLatency * 1000;
        if (!Number.isFinite(outputLatencyMs) || outputLatencyMs < 0) {
          state = {
            status: 'unsupported',
            latencyMs: null,
            compensationMs: 0,
            message: 'Il browser non espone una misura valida della latenza di uscita.',
          };
        } else if (outputLatencyMs > MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS) {
          state = {
            status: 'ignored',
            latencyMs: outputLatencyMs,
            compensationMs: 0,
            message: `Misura di ${Math.round(outputLatencyMs)} ms non compensata perché superiore alla soglia attendibile di ${MAX_TRUSTWORTHY_OUTPUT_LATENCY_MS} ms.`,
          };
        } else {
          const latencyMs = Math.round(outputLatencyMs);
          state = {
            status: 'measured',
            latencyMs,
            compensationMs: latencyMs,
            message: `Latenza stimata: ${latencyMs} ms; compensazione applicata. La pipeline HTML audio può avere buffering aggiuntivo.`,
          };
        }
      } catch (error) {
        console.warn('[AudioOutputLatency] Misurazione non riuscita:', error);
        state = {
          status: 'error',
          latencyMs: null,
          compensationMs: 0,
          message: 'Misurazione della latenza di uscita non riuscita; compensazione automatica disattivata.',
        };
      }

      return getState();
    })().finally(() => {
      measurement = null;
    });

    return measurement;
  }

  return {
    measure,
    getState,
    getCompensationMs: () => state.compensationMs,
  };
}
