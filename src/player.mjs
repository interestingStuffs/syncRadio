const SYNC_TOLERANCE_SECONDS = 0.01;
const SCHEDULE_LEAD_SECONDS = 0.02;

export function createAudioPlayer({
  onError = () => {},
  onStateChange = () => {},
  AudioContextConstructor = globalThis.AudioContext,
  fetchAudio = globalThis.fetch?.bind(globalThis),
  monotonicNow = () => performance.now(),
  onSyncMeasurement = () => {},
} = {}) {
  let context = null;
  let gainNode = null;
  let selectedTrack = null;
  let selectedTrackKey = null;
  let requestedOffsetMs = 0;
  let requestedAtMonotonicMs = 0;
  let playbackRequested = false;
  let playbackPending = null;
  let playbackGeneration = 0;
  let activeSource = null;
  let scheduledSource = null;
  let calibrationSource = null;
  let calibrationBuffer = null;
  let calibrationGeneration = 0;
  let volume = 1;
  let previousVolume = volume;
  let muted = false;
  const buffers = new Map();

  function getContext() {
    if (context) return context;
    if (typeof AudioContextConstructor !== 'function') {
      throw new Error('Questo browser non supporta Web Audio API (AudioContext).');
    }
    context = new AudioContextConstructor({ latencyHint: 'interactive' });
    gainNode = context.createGain();
    gainNode.gain.value = muted ? 0 : volume;
    gainNode.connect(context.destination);
    return context;
  }

  function loadTrack(track) {
    const existing = buffers.get(track.audioUrl);
    if (existing) return existing;

    const bufferPromise = (async () => {
      if (typeof fetchAudio !== 'function') {
        throw new Error('Il browser non supporta il caricamento dei file audio.');
      }
      let response;
      try {
        response = await fetchAudio(track.audioUrl);
      } catch {
        throw new Error('Traccia non raggiungibile. Verifica URL, connessione e permessi CORS.');
      }
      if (!response.ok) {
        throw new Error(`Traccia non disponibile (HTTP ${response.status}).`);
      }
      let audioData;
      try {
        audioData = await response.arrayBuffer();
        return await getContext().decodeAudioData(audioData);
      } catch {
        throw new Error('Impossibile decodificare la traccia. Verifica formato, file e permessi CORS.');
      }
    })();
    buffers.set(track.audioUrl, bufferPromise);
    void bufferPromise.catch(() => {
      if (buffers.get(track.audioUrl) === bufferPromise) buffers.delete(track.audioUrl);
    });
    return bufferPromise;
  }

  function keepBuffers(urls) {
    for (const url of buffers.keys()) {
      if (!urls.has(url)) buffers.delete(url);
    }
  }

  function stopActiveSource(when = context?.currentTime, notify = true) {
    const sources = [activeSource, scheduledSource].filter(Boolean);
    activeSource = null;
    scheduledSource = null;
    for (const source of sources) {
      source.stopScheduled = true;
      source.node.stop(when);
    }
    if (sources.length && notify) onStateChange(false);
  }

  function playbackPosition(source, contextTime = context.currentTime) {
    return source.offsetSeconds + Math.max(0, contextTime - source.startTime);
  }

  function promoteScheduledSource() {
    if (!scheduledSource || context.currentTime < scheduledSource.startTime) return false;
    activeSource = scheduledSource;
    scheduledSource = null;
    selectedTrack = activeSource.track;
    selectedTrackKey = activeSource.trackKey;
    keepBuffers(new Set([selectedTrack.audioUrl]));
    onStateChange(true);
    return true;
  }

  function createTrackSource(track, buffer, offsetSeconds, startTime) {
    const audioContext = getContext();
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = buffer;
    sourceNode.connect(gainNode);
    const source = {
      node: sourceNode,
      track,
      trackKey: `${track.id}\n${track.audioUrl}`,
      startTime,
      offsetSeconds,
      stopScheduled: false,
    };
    sourceNode.onended = () => {
      if (scheduledSource === source) {
        scheduledSource = null;
        return;
      }
      if (activeSource !== source) return;
      if (promoteScheduledSource()) return;
      activeSource = null;
      onStateChange(false);
    };
    sourceNode.start(startTime, offsetSeconds);
    return source;
  }

  function stopCalibrationTone() {
    calibrationGeneration += 1;
    if (!calibrationSource) return;
    const source = calibrationSource;
    calibrationSource = null;
    source.stop(context.currentTime);
  }

  async function scheduleCalibrationTone(delayMs) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError('delayMs deve essere un numero finito non negativo.');
    }

    stopCalibrationTone();
    const generation = calibrationGeneration;
    const requestedAt = monotonicNow();
    const audioContext = getContext();
    if (audioContext.state !== 'running') await audioContext.resume();
    if (generation !== calibrationGeneration) return;

    if (!calibrationBuffer) {
      const sampleRate = audioContext.sampleRate;
      const sampleCount = Math.floor(sampleRate * 0.08);
      calibrationBuffer = audioContext.createBuffer(1, sampleCount, sampleRate);
      const samples = calibrationBuffer.getChannelData(0);
      for (let index = 0; index < sampleCount; index += 1) {
        const envelope = Math.min(1, index / 150, (sampleCount - index) / 500);
        samples[index] = Math.sin((2 * Math.PI * 660 * index) / sampleRate) * envelope * 0.55;
      }
    }

    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = calibrationBuffer;
    sourceNode.connect(gainNode);
    sourceNode.onended = () => {
      if (calibrationSource === sourceNode) calibrationSource = null;
    };
    const remainingDelayMs = Math.max(0, delayMs - (monotonicNow() - requestedAt));
    sourceNode.start(audioContext.currentTime + remainingDelayMs / 1000);
    calibrationSource = sourceNode;
  }

  function scheduleTrack(track, buffer, offsetMs, requestedAtMs, generationKey) {
    const audioContext = getContext();
    const when = audioContext.currentTime + SCHEDULE_LEAD_SECONDS;
    const elapsedMs = Math.max(0, monotonicNow() - requestedAtMs);
    const startOffset = Math.max(0, offsetMs + elapsedMs + SCHEDULE_LEAD_SECONDS * 1000) / 1000;
    const maxOffset = Math.max(0, buffer.duration - 0.001);
    const offsetSeconds = Math.min(startOffset, maxOffset);
    const source = createTrackSource(track, buffer, offsetSeconds, when);
    const previousSource = activeSource;
    activeSource = source;
    if (previousSource && !previousSource.stopScheduled) {
      previousSource.stopScheduled = true;
      previousSource.node.stop(when);
    }
    onStateChange(true);
  }

  async function scheduleNextTrack(track, offsetMs, delayMs) {
    if (!track) return;
    if (!Number.isFinite(delayMs)) throw new TypeError('delayMs deve essere un numero finito.');
    if (!activeSource && playbackPending) await playbackPending;
    if (!playbackRequested || !activeSource) return;
    const trackKey = `${track.id}\n${track.audioUrl}`;
    if (scheduledSource?.trackKey === trackKey) return;
    const generationKey = playbackGeneration;
    const requestedAt = monotonicNow();
    const bufferPromise = loadTrack(track);
    keepBuffers(new Set([selectedTrack?.audioUrl, track.audioUrl].filter(Boolean)));
    const buffer = await bufferPromise;
    if (!playbackRequested || playbackGeneration !== generationKey) return;

    const audioContext = getContext();
    if (audioContext.state !== 'running') await audioContext.resume();
    if (!playbackRequested || playbackGeneration !== generationKey) return;
    if (scheduledSource?.trackKey === trackKey) return;
    if (scheduledSource) stopScheduledSource();

    const elapsedMs = Math.max(0, monotonicNow() - requestedAt);
    const remainingDelayMs = delayMs - elapsedMs;
    const schedulingLeadMs = Math.max(SCHEDULE_LEAD_SECONDS * 1000, remainingDelayMs);
    const lateMs = Math.max(0, SCHEDULE_LEAD_SECONDS * 1000 - remainingDelayMs);
    const offsetSeconds = Math.min(
      Math.max(0, offsetMs + lateMs) / 1000,
      Math.max(0, buffer.duration - 0.001),
    );
    const when = audioContext.currentTime + schedulingLeadMs / 1000;
    const source = createTrackSource(track, buffer, offsetSeconds, when);
    scheduledSource = source;
    if (activeSource && !activeSource.stopScheduled) {
      activeSource.stopScheduled = true;
      activeSource.node.stop(when);
    }
  }

  function stopScheduledSource() {
    if (!scheduledSource) return;
    const source = scheduledSource;
    scheduledSource = null;
    source.stopScheduled = true;
    source.node.stop(context.currentTime);
  }

  async function startTrack(track, offsetMs, force) {
    const promotedScheduledSource = promoteScheduledSource();
    const trackKey = `${track.id}\n${track.audioUrl}`;
    if (!force && promotedScheduledSource && selectedTrackKey === trackKey) return;
    if (!force && scheduledSource?.trackKey === trackKey && context.state === 'running') return;
    const isNewTrack = selectedTrackKey !== trackKey;
    if (!force && !isNewTrack && playbackPending) return playbackPending;

    if (!force && !isNewTrack && activeSource) {
      const now = monotonicNow();
      const remainingLeadMs = Math.max(0, activeSource.startTime - context.currentTime) * 1000;
      const expectedPosition = (Math.max(0, offsetMs) + remainingLeadMs) / 1000;
      const actualPosition = playbackPosition(activeSource);
      const driftMs = (actualPosition - expectedPosition) * 1000;
      const corrected = Math.abs(driftMs) > SYNC_TOLERANCE_SECONDS * 1000;
      onSyncMeasurement({ driftMs, corrected });
      requestedOffsetMs = Math.max(0, offsetMs);
      requestedAtMonotonicMs = now;
      if (!corrected) return;
    }

    playbackGeneration += 1;
    stopScheduledSource();
    selectedTrack = track;
    selectedTrackKey = trackKey;
    requestedOffsetMs = Math.max(0, offsetMs);
    requestedAtMonotonicMs = monotonicNow();
    if (isNewTrack) stopActiveSource(undefined, false);

    const generationKey = playbackGeneration;
    const requestedOffset = requestedOffsetMs;
    const requestedAt = requestedAtMonotonicMs;
    keepBuffers(new Set([track.audioUrl]));
    const pending = (async () => {
      const audioContext = getContext();
      if (audioContext.state !== 'running') await audioContext.resume();
      const buffer = await loadTrack(track);
      if (!playbackRequested || playbackGeneration !== generationKey) return;
      scheduleTrack(track, buffer, requestedOffset, requestedAt, generationKey);
    })();
    playbackPending = pending;
    try {
      await pending;
    } catch (error) {
      if (!playbackRequested || playbackGeneration !== generationKey) return;
      throw error;
    } finally {
      if (playbackPending === pending) playbackPending = null;
    }
  }

  function requestTrack(track, offsetMs, force = false) {
    if (!track) {
      pause();
      return;
    }
    playbackRequested = true;
    const request = startTrack(track, offsetMs, force);
    const generation = playbackGeneration;
    void request.catch((error) => {
      if (!playbackRequested || playbackGeneration !== generation) return;
      playbackRequested = false;
      stopActiveSource();
      onError(error.message);
    });
  }

  function pause() {
    playbackRequested = false;
    playbackPending = null;
    keepBuffers(new Set(selectedTrack ? [selectedTrack.audioUrl] : []));
    stopActiveSource();
  }

  return {
    preload(track) {
      if (!track) return Promise.resolve();
      keepBuffers(new Set([selectedTrack?.audioUrl, track.audioUrl].filter(Boolean)));
      const preload = loadTrack(track);
      void preload.catch(() => {});
      return preload;
    },
    tune(track, offsetMs) {
      playbackRequested = true;
      return startTrack(track, offsetMs, false);
    },
    realign(track, offsetMs) {
      playbackRequested = true;
      return startTrack(track, offsetMs, true);
    },
    scheduleCalibrationTone,
    stopCalibrationTone,
    scheduleNextTrack,
    pause,
    sync(track, offsetMs, force = false) {
      requestTrack(track, offsetMs, force);
    },
    setVolume(value) {
      volume = Math.min(1, Math.max(0, value));
      if (volume > 0) {
        previousVolume = volume;
        muted = false;
      }
      if (gainNode) gainNode.gain.value = muted ? 0 : volume;
    },
    toggleMute() {
      if (muted || volume === 0) {
        muted = false;
        if (volume === 0) volume = previousVolume;
      } else {
        previousVolume = volume;
        muted = true;
      }
      if (gainNode) gainNode.gain.value = muted ? 0 : volume;
    },
    isMuted() { return muted || volume === 0; },
    isPlaying() {
      promoteScheduledSource();
      return activeSource !== null;
    },
  };
}
