import { loadConfig } from './config.mjs';
import { createClock } from './clock.mjs';
import { loadStationManifest } from './data-source.mjs';
import { resolveTrackDurations } from './audio-metadata.mjs';
import { createAudioPlayer } from './player.mjs';
import { createAudioOutputLatencyMonitor } from './audio-output-latency.mjs';
import { createPlaybackSyncDiagnostics } from './playback-sync-diagnostics.mjs';
import {
  loadPlaybackOffset,
  savePlaybackOffset,
  PLAYBACK_OFFSET_STEP_MS,
  MAX_PLAYBACK_OFFSET_MS,
} from './playback-offset.mjs';
import { buildSchedule, locateTrack } from './timeline.mjs';

const TRACK_PRELOAD_LOOKAHEAD_MS = 10_000;
const MAX_CALIBRATION_ADJUSTMENT_MS = 500;
const CALIBRATION_STEP_INTERVAL_MS = 140;

const elements = Object.fromEntries([
  'station-name', 'station-description', 'station-switcher', 'station-select', 'clock-label',
  'track-time', 'track-title', 'track-artist',
  'progress-fill', 'elapsed-time', 'remaining-time', 'tune-button',
  'sync-reset-button', 'sync-reset-status', 'button-icon', 'button-label',
  'offset-decrease', 'offset-increase', 'offset-reset', 'playback-offset',
  'offset-calibration', 'calibration-cue', 'calibration-flash', 'calibration-toggle',
  'calibration-earlier', 'calibration-later', 'calibration-status',
  'volume-slider', 'volume-toggle', 'player-error', 'configuration-error', 'sync-status', 'sync-icon', 'sync-message',
  'schedule-count', 'schedule-list', 'schedule-footnote', 'on-air-indicator', 'manifest-status',
  'diagnostics-state', 'diagnostics-provider', 'diagnostics-utc', 'diagnostics-sample',
  'diagnostics-offset', 'diagnostics-uncertainty', 'diagnostics-latency', 'diagnostics-output-latency',
  'diagnostics-attempts', 'diagnostics-detail', 'diagnostics-playback-checks',
  'diagnostics-playback-interval', 'diagnostics-playback-drift', 'diagnostics-playback-corrections',
].map((id) => [id, document.getElementById(id)]));

let manifest = null;
let clock = null;
let player = null;
let audioOutputLatency = null;
const playbackSyncDiagnostics = createPlaybackSyncDiagnostics();
let playerError = '';
let tunedIn = false;
let tuningPending = false;
let tuningRequestId = 0;
let config = null;
let stationLoadId = 0;
let playbackCycleIndex = null;
let observedTrackStart = null;
let hasObservedSchedulePosition = false;
let playbackOffsetMs = loadPlaybackOffset();
let synchronizationResetPending = false;
let audioOutputLatencyMonitoringStarted = false;
let calibrationActive = false;
let calibrationRunId = 0;
let calibrationTimers = [];
let calibrationBaselineOffsetMs = 0;

async function start() {
  try {
    config = await loadConfig();
  } catch (error) {
    showConfigurationError(error.message);
    return;
  }
  elements['offset-calibration'].hidden = !config.showPlaybackCalibration;

  clock = createClock({
    sources: config.timeSources,
    timeoutMs: config.requestTimeoutMs,
    localFallback: config.localFallback,
  });
  player = createAudioPlayer({
    onSyncMeasurement: playbackSyncDiagnostics.recordDrift,
    onError: (message) => {
      playerError = message;
      if (tunedIn) {
        cancelTuning();
        player?.pause();
        renderPlayerState();
      }
      renderPlayerError();
    },
    onStateChange: renderPlayerState,
  });
  audioOutputLatency = createAudioOutputLatencyMonitor({
    maxCompensationMs: config.maxOutputLatencyCompensationMs,
  });
  player.setVolume(Number(elements['volume-slider'].value));
  renderVolumeState();
  elements['volume-slider'].addEventListener('input', (event) => {
    player.setVolume(Number(event.target.value));
    renderVolumeState();
  });
  elements['volume-toggle'].addEventListener('click', () => {
    player.toggleMute();
    renderVolumeState();
  });
  elements['tune-button'].addEventListener('click', toggleTuning);
  elements['sync-reset-button'].addEventListener('click', resetSynchronization);
  elements['offset-decrease'].addEventListener('click', () => changePlaybackOffset(-PLAYBACK_OFFSET_STEP_MS));
  elements['offset-increase'].addEventListener('click', () => changePlaybackOffset(PLAYBACK_OFFSET_STEP_MS));
  elements['offset-reset'].addEventListener('click', () => changePlaybackOffset(-playbackOffsetMs));
  elements['calibration-toggle'].addEventListener('click', () => {
    if (calibrationActive) {
      stopOffsetCalibration();
    } else {
      startOffsetCalibration();
    }
  });
  elements['calibration-earlier'].addEventListener('click', () => adjustOffsetCalibration(-PLAYBACK_OFFSET_STEP_MS));
  elements['calibration-later'].addEventListener('click', () => adjustOffsetCalibration(PLAYBACK_OFFSET_STEP_MS));
  elements['offset-calibration'].addEventListener('toggle', (event) => {
    if (!event.target.open) stopOffsetCalibration();
  });
  elements['station-select'].addEventListener('change', (event) => {
    const station = config.stations.find(({ id }) => id === event.target.value);
    if (station) {
      updateStationUrl(station);
      loadStation(station);
    }
  });

  renderStationOptions();
  renderPlaybackOffset();
  const initialStation = getStationFromUrl();
  updateStationUrl(initialStation, true);
  if (config.stationQueryParam) {
    window.addEventListener('popstate', () => {
      const station = getStationFromUrl();
      updateStationUrl(station, true);
      if (elements['station-select'].value !== station.id) loadStation(station);
    });
  }
  await Promise.allSettled([
    loadStation(initialStation),
    clock.synchronize(),
  ]);
  renderClockStatus();
  elements['sync-reset-button'].disabled = false;

  render();
  window.setInterval(() => {
    render();
  }, 1000);
  window.setInterval(syncPlayback, config.playbackSyncIntervalMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const clockRefresh = config.resyncOnTrackChangeOnly ? Promise.resolve() : clock.synchronize();
      clockRefresh.then(renderClockStatus, renderClockStatus).then(() => {
        if (audioOutputLatencyMonitoringStarted) void refreshAudioOutputLatency();
        syncPlayback();
        render();
      });
    }
  });
  if (!config.resyncOnTrackChangeOnly) {
    window.setInterval(() => {
      clock.synchronize().then(renderClockStatus).catch(renderClockStatus);
    }, config.resyncIntervalMs);
  }
}

function renderStationOptions() {
  const options = document.createDocumentFragment();
  for (const station of config.stations) {
    const option = document.createElement('option');
    option.value = station.id;
    option.textContent = station.name;
    options.append(option);
  }
  elements['station-select'].replaceChildren(options);
  elements['station-switcher'].hidden = !config.allowStationSwitch || config.stations.length < 2;
}

function getStationFromUrl() {
  const stationId = config.stationQueryParam
    ? new URL(window.location.href).searchParams.get(config.stationQueryParam)
    : null;
  return config.stations.find(({ id }) => id === stationId) || config.stations[0];
}

function updateStationUrl(station, replace = false) {
  if (!config.stationQueryParam) return;

  const url = new URL(window.location.href);
  if (url.searchParams.get(config.stationQueryParam) === station.id) return;
  url.searchParams.set(config.stationQueryParam, station.id);
  window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', url);
}

async function loadStation(station) {
  const loadId = ++stationLoadId;
  manifest = null;
  cancelTuning();
  playbackCycleIndex = null;
  observedTrackStart = null;
  hasObservedSchedulePosition = false;
  player.pause();
  playerError = '';
  elements['station-select'].value = station.id;
  elements['station-select'].disabled = true;
  elements['station-name'].textContent = station.name;
  elements['station-description'].textContent = station.description;
  elements['manifest-status'].textContent = 'CARICAMENTO MANIFESTO';
  elements['schedule-count'].textContent = '00';
  elements['schedule-list'].replaceChildren();
  elements['schedule-footnote'].textContent = 'Caricamento della scaletta…';
  elements['track-time'].textContent = '--:--';
  elements['track-title'].textContent = 'Caricamento della stazione…';
  elements['track-artist'].textContent = '';
  elements['progress-fill'].style.width = '0%';
  elements['elapsed-time'].textContent = '--:--';
  elements['remaining-time'].textContent = '--:--';
  elements['tune-button'].disabled = true;
  elements['configuration-error'].hidden = true;
  renderPlayerState();
  renderPlayerError();

  try {
    const loadedManifest = await loadStationManifest(
      station.manifestUrl,
      station.timelineStartsAt,
      config.requestTimeoutMs,
    );
    const loadedWithDurations = await resolveTrackDurations(loadedManifest, {
      timeoutMs: config.requestTimeoutMs,
      useManifestDurations: config.useManifestDurations,
    });
    if (loadId !== stationLoadId) return;
    manifest = { ...loadedWithDurations, repeat: station.repeat };
    renderManifest();
    render();
  } catch (error) {
    if (loadId !== stationLoadId) return;
    elements['manifest-status'].textContent = 'MANIFESTO NON DISPONIBILE';
    elements['schedule-footnote'].textContent = 'La scaletta non è disponibile.';
    elements['track-title'].textContent = 'Stazione non disponibile';
    showConfigurationError(error.message);
  } finally {
    if (loadId === stationLoadId) elements['station-select'].disabled = false;
  }
}

function renderManifest() {
  elements['manifest-status'].textContent = 'MANIFESTO UFFICIALE CARICATO';
  elements['schedule-count'].textContent = String(manifest.tracks.length).padStart(2, '0');
  const repeatNote = manifest.repeat ? ' La scaletta si ripete indefinitamente.' : ' La scaletta non si ripete.';
  elements['schedule-footnote'].textContent = `Inizio timeline: ${formatDateTime(Date.parse(manifest.timelineStartsAt))}.${repeatNote}`;
  renderSchedule();
  elements['tune-button'].disabled = false;
  elements['configuration-error'].hidden = true;
}

function renderSchedule() {
  const schedule = buildSchedule(manifest);
  const list = document.createDocumentFragment();

  for (const item of schedule) {
    const entry = document.createElement('li');
    entry.className = 'schedule-item';
    entry.dataset.trackId = item.track.id;

    const time = document.createElement('time');
    time.dateTime = new Date(item.startsAt).toISOString();
    time.textContent = formatTime(item.startsAt);

    const details = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'schedule-track-title';
    title.textContent = item.track.title;
    const artist = document.createElement('div');
    artist.className = 'schedule-artist';
    artist.textContent = item.track.artist;
    details.append(title, artist);

    const duration = document.createElement('span');
    duration.className = 'schedule-duration';
    duration.textContent = formatDuration(item.track.durationMs);
    entry.append(time, details, duration);
    list.append(entry);
  }

  elements['schedule-list'].replaceChildren(list);
}

function render() {
  renderClockLabel();
  renderClockStatus();
  if (!manifest) return;

  const timestamp = clock.now();
  if (timestamp === null) {
    elements['track-time'].textContent = '--:--';
    elements['track-title'].textContent = 'Orologio comune non disponibile';
    elements['track-artist'].textContent = 'Le sorgenti configurate non rispondono e il fallback locale è disattivato.';
    elements['progress-fill'].style.width = '0%';
    elements['elapsed-time'].textContent = '--:--';
    elements['remaining-time'].textContent = '--:--';
    elements['tune-button'].disabled = true;
    if (tunedIn) {
      cancelTuning();
      player.pause();
      renderPlayerState();
    }
    return;
  }

  elements['tune-button'].disabled = false;
  const position = locatePlaybackPosition(timestamp);
  observeScheduledTrack(position);
  const entries = elements['schedule-list'].children;
  for (let index = 0; index < entries.length; index += 1) {
    entries[index].classList.toggle('is-current', index === position.index);
    entries[index].classList.toggle('is-past', index < position.index);
  }

  if (!position.track) {
    elements['track-time'].textContent = '--:--';
    elements['track-title'].textContent = position.elapsedMs < 0 ? 'La trasmissione non è ancora iniziata' : 'La scaletta è terminata';
    elements['track-artist'].textContent = position.elapsedMs < 0
      ? `La prima traccia parte alle ${formatDateTime(Date.parse(manifest.timelineStartsAt))}.`
      : 'Non sono previste altre tracce nel manifesto ufficiale.';
    elements['progress-fill'].style.width = '0%';
    elements['elapsed-time'].textContent = '--:--';
    elements['remaining-time'].textContent = '--:--';
    if (tunedIn) {
      cancelTuning();
      player.pause();
      renderPlayerState();
    }
    return;
  }

  elements['track-time'].textContent = `${formatTime(position.startsAt)} · ${position.index + 1} / ${manifest.tracks.length}`;
  elements['track-title'].textContent = position.track.title;
  elements['track-artist'].textContent = position.track.artist;
  elements['elapsed-time'].textContent = formatDuration(position.offsetMs);
  elements['remaining-time'].textContent = `−${formatDuration(position.track.durationMs - position.offsetMs)}`;
  elements['progress-fill'].style.width = `${Math.min(100, (position.offsetMs / position.track.durationMs) * 100)}%`;
  elements['on-air-indicator'].lastChild.textContent = tunedIn ? ' IN ASCOLTO' : ' PROGRAMMAZIONE';
  elements['on-air-indicator'].classList.toggle('is-playing', tunedIn);
}

function observeScheduledTrack(position) {
  const trackStart = position.track ? position.startsAt : null;
  const trackChanged = hasObservedSchedulePosition
    && trackStart !== null
    && trackStart !== observedTrackStart;
  if (trackChanged) {
    if (audioOutputLatency.getState().pendingCompensationMs !== null) {
      audioOutputLatency.applyMeasurement();
      renderAudioOutputLatency();
    }
    if (config.resyncOnTrackChangeOnly) {
      clock.synchronize().then(renderClockStatus, renderClockStatus);
    }
  }
  observedTrackStart = trackStart;
  hasObservedSchedulePosition = true;
}

function syncPlayback() {
  if (!tunedIn || !manifest || !clock) return;
  const timestamp = clock.now();
  if (timestamp === null) {
    cancelTuning();
    player.pause();
    renderPlayerState();
    return;
  }

  const position = locatePlaybackPosition(timestamp);
  observeScheduledTrack(position);
  if (!position.track) {
    cancelTuning();
    player.pause();
    renderPlayerState();
    render();
    return;
  }
  const cycleChanged = playbackCycleIndex !== null && playbackCycleIndex !== position.cycleIndex;
  playbackCycleIndex = position.cycleIndex;
  playbackSyncDiagnostics.recordCheck();
  player.sync(position.track, getPlayerOffset(position.offsetMs), cycleChanged);

  const nextTrack = manifest.tracks[position.index + 1]
    || (manifest.repeat ? manifest.tracks[0] : null);
  if (nextTrack && position.endsAt - (timestamp + playbackOffsetMs + audioOutputLatency.getCompensationMs()) <= TRACK_PRELOAD_LOOKAHEAD_MS) {
    player.preload(nextTrack);
  }
}

async function toggleTuning() {
  if (tunedIn) {
    cancelTuning();
    player.pause();
    renderPlayerState();
    render();
    return;
  }

  const timestamp = clock.now();
  if (timestamp === null) {
    playerError = 'Nessun orologio disponibile e fallback locale disattivato.';
    renderPlayerError();
    return;
  }
  const position = locatePlaybackPosition(timestamp);
  if (!position.track) {
    playerError = position.elapsedMs < 0 ? 'La programmazione ufficiale non è ancora iniziata.' : 'La programmazione ufficiale è terminata.';
    renderPlayerError();
    return;
  }

  playerError = '';
  renderPlayerError();
  tunedIn = true;
  tuningPending = true;
  const requestId = ++tuningRequestId;
  renderPlayerState();
  playbackCycleIndex = position.cycleIndex;
  const previousCompensationMs = audioOutputLatency.getCompensationMs();
  const latencyMeasurement = audioOutputLatency.measure();
  try {
    await player.tune(position.track, getPlayerOffset(position.offsetMs));
    if (requestId !== tuningRequestId) return;
    tuningPending = false;
    renderPlayerState();
    await latencyMeasurement;
    if (requestId !== tuningRequestId) return;
    audioOutputLatency.applyMeasurement();
    renderAudioOutputLatency();
    if (tunedIn && audioOutputLatency.getCompensationMs() !== previousCompensationMs) {
      await realignPlayback();
    }
    startAudioOutputLatencyMonitoring();
  } catch (error) {
    if (requestId !== tuningRequestId) return;
    cancelTuning();
    player.pause();
    playerError = error.name === 'NotAllowedError'
      ? 'Il browser ha bloccato la riproduzione. Premi Sintonizzati per riprovare.'
      : 'Riproduzione non riuscita. Verifica che l’URL punti a un file audio diretto e accessibile.';
  }
  renderPlayerState();
  renderPlayerError();
  render();
}

function cancelTuning() {
  tuningRequestId += 1;
  tuningPending = false;
  tunedIn = false;
  playbackSyncDiagnostics.reset();
}

async function realignPlayback() {
  if (!tunedIn) return false;

  const timestamp = clock.now();
  if (timestamp === null) {
    playerError = 'Nessun orologio disponibile e fallback locale disattivato.';
    renderPlayerError();
    return false;
  }
  const position = locatePlaybackPosition(timestamp);
  if (!position.track) {
    playerError = position.elapsedMs < 0 ? 'La programmazione ufficiale non è ancora iniziata.' : 'La programmazione ufficiale è terminata.';
    renderPlayerError();
    return false;
  }

  playerError = '';
  renderPlayerError();
  playbackCycleIndex = position.cycleIndex;
  try {
    await player.realign(position.track, getPlayerOffset(position.offsetMs));
  } catch (error) {
    playerError = error.name === 'NotAllowedError'
      ? 'Il browser ha bloccato la riproduzione. Premi Sintonizzati per riprovare.'
      : 'Riallineamento non riuscito. Verifica che il file audio consenta la ricerca.';
  }
  renderPlayerState();
  renderPlayerError();
  render();
  return !playerError;
}

async function resetSynchronization() {
  if (!clock || synchronizationResetPending) return;

  synchronizationResetPending = true;
  elements['sync-reset-button'].disabled = true;
  elements['sync-reset-button'].textContent = 'Risincronizzazione…';
  elements['sync-reset-status'].hidden = true;
  elements['sync-reset-status'].classList.remove('is-error');

  try {
    await clock.reset();
    await audioOutputLatency.measure();
    audioOutputLatency.applyMeasurement();
    renderAudioOutputLatency();
    renderClockStatus();
    const realigned = tunedIn ? await realignPlayback() : true;
    elements['sync-reset-status'].textContent = realigned
      ? tunedIn
        ? 'Orologio aggiornato e audio riallineato. Offset manuale mantenuto.'
        : 'Orologio aggiornato. Offset manuale mantenuto.'
      : 'Orologio aggiornato, ma il riallineamento audio non è riuscito.';
    elements['sync-reset-status'].classList.toggle('is-error', !realigned);
  } catch (error) {
    renderClockStatus();
    elements['sync-reset-status'].textContent = `Risincronizzazione non riuscita: ${error.message}`;
    elements['sync-reset-status'].classList.add('is-error');
  } finally {
    synchronizationResetPending = false;
    elements['sync-reset-button'].disabled = false;
    elements['sync-reset-button'].textContent = 'Risincronizza dispositivi';
    elements['sync-reset-status'].hidden = false;
  }
}

function startAudioOutputLatencyMonitoring() {
  if (audioOutputLatencyMonitoringStarted) return;
  audioOutputLatencyMonitoringStarted = true;
  globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', refreshAudioOutputLatency);
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshAudioOutputLatency();
  }, config.outputLatencyRefreshIntervalMs);
}

async function refreshAudioOutputLatency() {
  await audioOutputLatency.measure();
  renderAudioOutputLatency();
}

function locatePlaybackPosition(timestamp) {
  return locateTrack(manifest, timestamp + playbackOffsetMs);
}

function getPlayerOffset(offsetMs) {
  return offsetMs + audioOutputLatency.getCompensationMs();
}

function changePlaybackOffset(changeMs) {
  playbackOffsetMs = savePlaybackOffset(playbackOffsetMs + changeMs);
  renderPlaybackOffset();
  if (tunedIn) {
    void realignPlayback();
  } else {
    render();
  }
}

function renderPlaybackOffset() {
  const sign = playbackOffsetMs > 0 ? '+' : '';
  const calibrationDelta = playbackOffsetMs - calibrationBaselineOffsetMs;
  const calibrating = calibrationActive;
  elements['playback-offset'].textContent = `${sign}${playbackOffsetMs} ms`;
  elements['offset-decrease'].disabled = playbackOffsetMs <= -MAX_PLAYBACK_OFFSET_MS
    || (calibrating && calibrationDelta <= -MAX_CALIBRATION_ADJUSTMENT_MS);
  elements['offset-increase'].disabled = playbackOffsetMs >= MAX_PLAYBACK_OFFSET_MS
    || (calibrating && calibrationDelta >= MAX_CALIBRATION_ADJUSTMENT_MS);
  elements['offset-reset'].disabled = playbackOffsetMs === 0 || calibrating;
  elements['calibration-earlier'].disabled = !calibrating
    || playbackOffsetMs <= -MAX_PLAYBACK_OFFSET_MS
    || calibrationDelta <= -MAX_CALIBRATION_ADJUSTMENT_MS;
  elements['calibration-later'].disabled = !calibrating
    || playbackOffsetMs >= MAX_PLAYBACK_OFFSET_MS
    || calibrationDelta >= MAX_CALIBRATION_ADJUSTMENT_MS;
}

function startOffsetCalibration() {
  if (calibrationActive) return;
  calibrationActive = true;
  calibrationRunId += 1;
  calibrationBaselineOffsetMs = playbackOffsetMs;
  elements['calibration-toggle'].textContent = 'Termina';
  elements['calibration-toggle'].setAttribute('aria-pressed', 'true');
  elements['calibration-status'].textContent = 'Test in corso: confronta il beep con il flash e regola finché sembrano simultanei.';
  renderPlaybackOffset();
  scheduleCalibrationCue();
}

function scheduleCalibrationCue() {
  if (!calibrationActive) return;
  const cycleStart = performance.now() + 400;
  const flashAt = cycleStart + 700;
  const offsetChangeMs = playbackOffsetMs - calibrationBaselineOffsetMs;
  const beepAt = flashAt - audioOutputLatency.getCompensationMs() - offsetChangeMs;
  const precedingSteps = elements['calibration-cue'].querySelectorAll('.calibration-step-before');
  const followingSteps = elements['calibration-cue'].querySelectorAll('.calibration-step-after');
  for (const step of followingSteps) step.classList.remove('is-active');
  const visualEvents = [
    ...[...precedingSteps].map((step, index) => ({
      at: cycleStart + index * CALIBRATION_STEP_INTERVAL_MS,
      run: () => step.classList.add('is-active'),
    })),
    {
      at: flashAt,
      run: () => {
        for (const step of precedingSteps) step.classList.remove('is-active');
        elements['calibration-flash'].classList.add('is-active');
        scheduleCalibrationTimeout(() => {
          elements['calibration-flash'].classList.remove('is-active');
        }, 120);
      },
    },
    ...[...followingSteps].map((step, index) => ({
      at: flashAt + 180 + index * CALIBRATION_STEP_INTERVAL_MS,
      run: () => step.classList.add('is-active'),
    })),
  ];
  scheduleCalibrationVisualEvent(visualEvents, 0);
  const runId = calibrationRunId;
  void player.scheduleCalibrationTone(Math.max(0, beepAt - performance.now())).catch((error) => {
    if (!calibrationActive || calibrationRunId !== runId) return;
    stopOffsetCalibration(`Riproduzione del beep non riuscita: ${error.message}`);
  });
  scheduleCalibrationTimeout(scheduleCalibrationCue, Math.max(0, cycleStart + 1800 - performance.now()));
}

function scheduleCalibrationVisualEvent(events, index) {
  if (!calibrationActive || index >= events.length) return;
  const event = events[index];
  scheduleCalibrationTimeout(() => {
    event.run();
    scheduleCalibrationVisualEvent(events, index + 1);
  }, Math.max(0, event.at - performance.now()));
}

function scheduleCalibrationTimeout(callback, delayMs) {
  const timer = window.setTimeout(() => {
    calibrationTimers = calibrationTimers.filter((pendingTimer) => pendingTimer !== timer);
    callback();
  }, delayMs);
  calibrationTimers.push(timer);
}

function adjustOffsetCalibration(changeMs) {
  const nextDelta = playbackOffsetMs + changeMs - calibrationBaselineOffsetMs;
  if (Math.abs(nextDelta) > MAX_CALIBRATION_ADJUSTMENT_MS) return;
  changePlaybackOffset(changeMs);
  if (!calibrationActive) return;
  player.stopCalibrationTone();
  clearCalibrationCueTimers();
  resetCalibrationCueVisuals();
  elements['calibration-status'].textContent = `Offset aggiornato a ${playbackOffsetMs} ms. Continua finché beep e flash sembrano simultanei.`;
  scheduleCalibrationCue();
}

function stopOffsetCalibration(statusMessage = null) {
  const wasRunning = calibrationActive;
  calibrationActive = false;
  calibrationRunId += 1;
  player?.stopCalibrationTone();
  clearCalibrationCueTimers();
  resetCalibrationCueVisuals();
  elements['calibration-toggle'].textContent = 'Avvia test';
  elements['calibration-toggle'].setAttribute('aria-pressed', 'false');
  renderPlaybackOffset();
  if (statusMessage) {
    elements['calibration-status'].textContent = statusMessage;
  } else if (wasRunning) {
    elements['calibration-status'].textContent = `Test terminato. Offset mantenuto: ${playbackOffsetMs} ms.`;
  }
}

function clearCalibrationCueTimers() {
  for (const timer of calibrationTimers) window.clearTimeout(timer);
  calibrationTimers = [];
}

function resetCalibrationCueVisuals() {
  elements['calibration-flash'].classList.remove('is-active');
  for (const step of elements['calibration-cue'].querySelectorAll('.calibration-step')) {
    step.classList.remove('is-active');
  }
}

function renderPlayerState() {
  const playing = tunedIn && player?.isPlaying();
  elements['tune-button'].classList.toggle('is-loading', tuningPending);
  elements['tune-button'].setAttribute('aria-busy', String(tuningPending));
  elements['button-icon'].textContent = tuningPending ? '' : tunedIn ? '■' : '▶';
  elements['button-label'].textContent = tuningPending
    ? 'Avvio audio…'
    : tunedIn ? 'Disconnettiti' : 'Sintonizzati';
  elements['on-air-indicator'].classList.toggle('is-playing', Boolean(playing));
  elements['on-air-indicator'].lastChild.textContent = playing ? ' IN ASCOLTO' : ' PROGRAMMAZIONE';
}

function renderVolumeState() {
  const muted = player?.isMuted() ?? false;
  elements['volume-toggle'].setAttribute('aria-pressed', String(muted));
  elements['volume-toggle'].setAttribute('aria-label', muted ? 'Attiva audio' : 'Disattiva audio');
}

function renderPlayerError() {
  elements['player-error'].textContent = playerError;
  elements['player-error'].hidden = !playerError;
}

function renderClockStatus() {
  if (!clock) return;
  const status = clock.status();
  const element = elements['sync-status'];
  element.classList.toggle('is-fallback', status.fallback || Boolean(status.usingFallbackSource));
  element.classList.toggle('is-error', !status.synchronized && Boolean(status.error));
  elements['sync-icon'].textContent = status.synchronized ? (status.usingFallbackSource ? '↪' : '◷') : '!';

  if (status.fallback) {
    elements['sync-message'].textContent = status.error
      ? `${status.error} Fallback sull’orologio locale: la sincronizzazione condivisa non è garantita.`
      : 'Orologio locale in uso: nessuna API dell’ora ha risposto. La sincronizzazione condivisa non è garantita.';
  } else if (!status.synchronized) {
    elements['sync-message'].textContent = status.error || 'Orologio comune non disponibile.';
  } else {
    const offset = formatOffset(status.offsetMs);
    const uncertainty = Math.round(status.uncertaintyMs);
    const route = status.usingFallbackSource ? ' · sorgente di fallback' : '';
    const warning = status.sourceWarning ? ` Avviso provider: ${status.sourceWarning}` : '';
    const stale = status.error ? ` Risincronizzazione fallita: ${status.error}` : '';
    elements['sync-message'].textContent = `Orologio comune attivo via ${status.source}${route} · scarto locale ${offset} · RTT minimo su ${status.lastSample.sampleCount} campioni · incertezza stimata ±${uncertainty} ms.${warning}${stale}`;
  }

  renderDiagnostics(status);
}

function renderDiagnostics(status) {
  let stateLabel = 'Non sincronizzato';
  let stateClass = 'is-bad';
  if (status.synchronized && !status.error && !status.usingFallbackSource) {
    stateLabel = 'Sincronizzato';
    stateClass = 'is-good';
  } else if (status.synchronized) {
    stateLabel = status.error ? 'Ultimo campione valido' : 'Provider secondario';
    stateClass = 'is-warning';
  } else if (status.fallback) {
    stateLabel = 'Ora locale';
    stateClass = 'is-warning';
  }
  elements['diagnostics-state'].textContent = stateLabel;
  elements['diagnostics-state'].className = `diagnostics-state ${stateClass}`;

  const source = status.source;
  elements['diagnostics-provider'].textContent = source
    ? `${source} · ${hostnameForSource(status.attempts, source)}`
    : status.fallback ? 'Nessun provider; fallback sul dispositivo' : 'Nessun provider attivo';

  const timestamp = clock.now();
  elements['diagnostics-utc'].textContent = timestamp === null ? '--' : formatPreciseUtc(timestamp);
  elements['diagnostics-sample'].textContent = status.lastSample
    ? formatPreciseUtc(status.lastSample.utcMs)
    : '--';
  elements['diagnostics-offset'].textContent = Number.isFinite(status.offsetMs)
    ? formatSignedMilliseconds(status.offsetMs)
    : 'Non misurato';
  elements['diagnostics-uncertainty'].textContent = Number.isFinite(status.uncertaintyMs)
    ? `±${Math.round(status.uncertaintyMs)} ms`
    : '--';
  elements['diagnostics-latency'].textContent = status.lastSample
    ? `${Math.round(status.lastSample.latencyMs)} ms · HTTP ${status.lastSample.httpStatus}`
    : '--';
  renderPlaybackSyncDiagnostics();
  renderAudioOutputLatency();

  const attempts = document.createDocumentFragment();
  for (const attempt of status.attempts) {
    const row = document.createElement('li');
    row.className = `diagnostic-attempt-${attempt.state}`;
    const label = document.createElement('span');
    label.className = 'diagnostic-source';
    label.textContent = `${attempt.name} · ${hostnameFromUrl(attempt.url)}`;
    const result = document.createElement('span');
    result.className = 'diagnostic-result';
    result.textContent = attempt.state === 'ok'
      ? `RTT min ${Math.round(attempt.latencyMs)} ms · ${attempt.sampleCount} campioni`
      : attempt.state === 'error'
        ? attempt.error
        : attempt.state === 'skipped' ? 'Non necessario · provider precedente attivo' : 'In attesa';
    row.append(label, result);
    attempts.append(row);
  }
  elements['diagnostics-attempts'].replaceChildren(attempts);
  elements['diagnostics-detail'].textContent = status.error || status.sourceWarning || 'Nessun errore nell’ultimo tentativo.';
}

function renderPlaybackSyncDiagnostics() {
  const status = playbackSyncDiagnostics.getState(config.playbackSyncIntervalMs);
  elements['diagnostics-playback-checks'].textContent = String(status.checkCount);
  elements['diagnostics-playback-interval'].textContent = status.averageIntervalMs === null
    ? `${status.configuredIntervalMs} ms configurati · in attesa`
    : `${status.configuredIntervalMs} ms configurati · ${Math.round(status.averageIntervalMs)} ms effettivi`;
  elements['diagnostics-playback-drift'].textContent = status.driftSampleCount
    ? `${status.driftSampleCount} misure · media ${status.averageAbsoluteDriftMs.toFixed(1)} ms · max ${status.maxAbsoluteDriftMs.toFixed(1)} ms`
    : 'In attesa della riproduzione stabile';
  elements['diagnostics-playback-corrections'].textContent = String(status.correctionCount);
}

function renderAudioOutputLatency() {
  if (!audioOutputLatency) return;
  const status = audioOutputLatency.getState();
  elements['diagnostics-output-latency'].textContent = status.message;
}

function hostnameForSource(attempts, name) {
  const source = attempts.find((attempt) => attempt.name === name);
  return source ? hostnameFromUrl(source.url) : 'host non disponibile';
}

function hostnameFromUrl(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return 'host non valido';
  }
}

function renderClockLabel() {
  if (!clock) return;
  const timestamp = clock.now();
  if (timestamp === null) {
    elements['clock-label'].textContent = 'Ora UTC non disponibile';
    return;
  }
  elements['clock-label'].textContent = new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  }).format(timestamp);
}

function showConfigurationError(message) {
  elements['configuration-error'].textContent = message;
  elements['configuration-error'].hidden = false;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(timestamp);
}

function formatDateTime(timestamp) {
  return new Intl.DateTimeFormat('it-IT', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', timeZoneName: 'short',
  }).format(timestamp);
}

function formatDuration(milliseconds) {
  const totalMilliseconds = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1000);
  const remainder = totalMilliseconds % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`;
}

function formatOffset(offsetMs) {
  const rounded = Math.round(offsetMs);
  return `${rounded >= 0 ? '+' : '−'}${Math.abs(rounded)} ms`;
}

function formatSignedMilliseconds(milliseconds) {
  const value = Math.round(milliseconds);
  return `${value >= 0 ? '+' : '−'}${Math.abs(value)} ms`;
}

function formatPreciseUtc(timestamp) {
  return new Date(timestamp).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

start();