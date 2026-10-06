const SYNC_TOLERANCE_SECONDS = 0.01;

export function createAudioPlayer({ onError = () => {}, onStateChange = () => {} } = {}) {
  let audio = new Audio();
  audio.preload = 'auto';
  let selectedTrackId = null;
  let selectedTrackUrl = null;
  let metadataTrackId = null;
  let endedTrackId = null;
  let requestedOffsetMs = 0;
  let requestedAtMonotonicMs = 0;
  let playbackRequested = false;
  let playPending = false;
  let trackGeneration = 0;
  let positionErrorReported = false;
  let failedTrackId = null;
  let previousVolume = audio.volume;
  let preloaded = null;
  const attachedAudios = new WeakSet();

  function attachAudio(element) {
    if (attachedAudios.has(element)) return;
    attachedAudios.add(element);
    element.addEventListener('play', () => {
      if (element === audio) onStateChange(true);
    });
    element.addEventListener('pause', () => {
      if (element === audio) onStateChange(false);
    });
    element.addEventListener('loadedmetadata', () => {
      if (element !== audio) return;
      metadataTrackId = selectedTrackId;
      correctPosition();
      requestPlayback();
    });
    element.addEventListener('seeked', () => {
      if (element !== audio) return;
      correctPosition();
      requestPlayback();
    });
    element.addEventListener('ended', () => {
      if (element !== audio) return;
      endedTrackId = selectedTrackId;
      onStateChange(false);
    });
    element.addEventListener('error', () => {
      if (element !== audio) return;
      const code = element.error?.code;
      const reason = code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        ? 'Formato o URL audio non supportato dal browser.'
        : 'Audio non raggiungibile o non riproducibile. Verifica il file e i permessi CORS.';
      onError(reason);
    });
  }

  function releaseAudio(element) {
    element.pause();
    if (typeof element.removeAttribute === 'function') {
      element.removeAttribute('src');
      element.load();
    }
  }

  function clearPreload() {
    if (!preloaded) return;
    releaseAudio(preloaded.audio);
    preloaded = null;
  }

  attachAudio(audio);

  function preloadTrack(track) {
    if (!track || (track.id === selectedTrackId && track.audioUrl === selectedTrackUrl)) return;
    if (preloaded?.trackId === track.id && preloaded.audioUrl === track.audioUrl) return;

    clearPreload();
    const candidate = new Audio();
    candidate.preload = 'auto';
    candidate.src = track.audioUrl;
    candidate.load();
    preloaded = { trackId: track.id, audioUrl: track.audioUrl, audio: candidate };
  }

  function selectTrack(track, offsetMs, force = false) {
    const isNewTrack = selectedTrackId !== track.id || selectedTrackUrl !== track.audioUrl;
    if (!force && !isNewTrack && (playPending || (!audio.paused && metadataTrackId === selectedTrackId))) return;

    requestedOffsetMs = Math.max(0, offsetMs);
    requestedAtMonotonicMs = performance.now();
    if (isNewTrack) {
      selectedTrackId = track.id;
      selectedTrackUrl = track.audioUrl;
      metadataTrackId = null;
      endedTrackId = null;
      positionErrorReported = false;
      failedTrackId = null;
      const warmedAudio = preloaded?.trackId === track.id
        && preloaded.audioUrl === track.audioUrl
        && !preloaded.audio.error
        ? preloaded.audio
        : null;
      const previousAudio = audio;
      if (warmedAudio) {
        preloaded = null;
        audio = warmedAudio;
        audio.volume = previousAudio.volume;
        audio.muted = previousAudio.muted;
        metadataTrackId = audio.readyState >= 1 ? selectedTrackId : null;
        attachAudio(audio);
        releaseAudio(previousAudio);
      } else {
        clearPreload();
        audio.src = track.audioUrl;
        audio.load();
      }
    } else if (force) {
      endedTrackId = null;
      positionErrorReported = false;
      failedTrackId = null;
    }
    if (isNewTrack || force) trackGeneration += 1;
    correctPosition();
  }

  function correctPosition() {
    if (metadataTrackId !== selectedTrackId) return;

    const duration = audio.duration;
    const elapsedMs = Math.max(0, performance.now() - requestedAtMonotonicMs);
    const expectedSeconds = Math.round(requestedOffsetMs + elapsedMs) / 1000;
    const targetSeconds = Number.isFinite(duration)
      ? Math.min(expectedSeconds, Math.max(0, duration - SYNC_TOLERANCE_SECONDS))
      : expectedSeconds;

    if (audio.seeking) return;
    if (Math.abs(audio.currentTime - targetSeconds) > SYNC_TOLERANCE_SECONDS) {
      try {
        audio.currentTime = targetSeconds;
      } catch {
        if (!positionErrorReported) {
          positionErrorReported = true;
          onError('Impossibile cercare nel file audio: verifica che il server supporti le richieste di intervallo.');
        }
      }
    }
  }

  function requestPlayback({ reportError = true } = {}) {
    if (!playbackRequested || playPending || !audio.paused
      || audio.seeking || endedTrackId === selectedTrackId || failedTrackId === selectedTrackId) {
      return Promise.resolve();
    }
    const trackId = selectedTrackId;
    const generation = trackGeneration;
    const playbackAudio = audio;
    playPending = true;
    let playback;
    try {
      playback = playbackAudio.play();
    } catch (error) {
      playback = Promise.reject(error);
    }
    return Promise.resolve(playback).then(() => {
      if (!playbackRequested || playbackAudio !== audio) playbackAudio.pause();
    }).catch((error) => {
      if (!playbackRequested || trackGeneration !== generation) return;
      failedTrackId = trackId;
      if (reportError) {
        onError(playbackMessage(error));
        return;
      }
      throw error;
    }).finally(() => {
      playPending = false;
      if (playbackRequested && trackGeneration !== generation) requestPlayback();
    });
  }

  function pausePlayback() {
    playbackRequested = false;
    clearPreload();
    audio.pause();
  }

  return {
    preload: preloadTrack,
    tune(track, offsetMs) {
      playbackRequested = true;
      failedTrackId = null;
      selectTrack(track, offsetMs);
      return requestPlayback({ reportError: false });
    },
    realign(track, offsetMs) {
      playbackRequested = true;
      failedTrackId = null;
      selectTrack(track, offsetMs, true);
      return requestPlayback({ reportError: false });
    },
    pause: pausePlayback,
    sync(track, offsetMs, force = false) {
      if (!track) {
        pausePlayback();
        return;
      }
      selectTrack(track, offsetMs, force);
      requestPlayback();
    },
    setVolume(value) {
      audio.volume = Math.min(1, Math.max(0, value));
      if (audio.volume > 0) {
        previousVolume = audio.volume;
        audio.muted = false;
      }
    },
    toggleMute() {
      if (audio.muted || audio.volume === 0) {
        audio.muted = false;
        if (audio.volume === 0) audio.volume = previousVolume;
        return;
      }
      previousVolume = audio.volume;
      audio.muted = true;
    },
    isMuted() { return audio.muted || audio.volume === 0; },
    isPlaying() { return !audio.paused; },
  };
}

function playbackMessage(error) {
  if (error?.name === 'NotAllowedError') return 'Il browser ha bloccato l’audio. Premi Sintonizzati per riprovare.';
  return 'Riproduzione non riuscita. Verifica che l’URL punti a un file audio diretto e accessibile.';
}
