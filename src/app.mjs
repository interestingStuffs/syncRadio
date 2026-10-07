import { loadConfig } from './config.mjs';
import { createClock } from './clock.mjs';
import { loadStationManifest } from './data-source.mjs';
import { resolveTrackDurations } from './audio-metadata.mjs';
import { createAudioPlayer } from './player.mjs';
import { createAudioOutputLatencyMonitor } from './audio-output-latency.mjs';
import {
  loadPlaybackOffset,
  savePlaybackOffset,
  parsePlaybackOffset,
  PLAYBACK_OFFSET_STEP_MS,
  MAX_PLAYBACK_OFFSET_MS,
} from './playback-offset.mjs';
import { buildSchedule, locateTrack } from './timeline.mjs';

const TRACK_PRELOAD_LOOKAHEAD_MS = 10_000;

const elements = Object.fromEntries([
  'station-name', 'station-description', 'station-switcher', 'station-select', 'clock-label',
  'track-time', 'track-title', 'track-artist',
  'progress-fill', 'elapsed-time', 'remaining-time', 'tune-button',
  'sync-reset-button', 'sync-reset-status', 'button-icon', 'button-label',
  'offset-decrease', 'offset-increase', 'offset-reset', 'playback-offset',
  'volume-slider', 'volume-toggle', 'player-error', 'configuration-error', 'sync-status', 'sync-icon', 'sync-message',
  'schedule-count', 'schedule-list', 'schedule-footnote', 'on-air-indicator', 'manifest-status',
  'diagnostics-state', 'diagnostics-provider', 'diagnostics-utc', 'diagnostics-sample',
  'diagnostics-offset', 'diagnostics-uncertainty', 'diagnostics-latency', 'diagnostics-output-latency',
  'diagnostics-attempts', 'diagnostics-detail',
].map((id) => [id, document.getElementById(id)]));

let manifest = null;
let clock = null;
let player = null;
let audioOutputLatency = null;
let playerError = '';
let tunedIn = false;
let config = null;
let stationLoadId = 0;
let playbackCycleIndex = null;
let playbackOffsetMs = loadPlaybackOffset();
let synchronizationResetPending = false;

async function start() {
  try {
    config = await loadConfig();
  } catch (error) {
    showConfigurationError(error.message);
    return;
  }

  if (config.playbackOffsetQueryParam) {
    playbackOffsetMs = savePlaybackOffset(getPlaybackOffsetFromUrl() ?? 0);
    updatePlaybackOffsetUrl(true);
  }

  clock = createClock({
    sources: config.timeSources,
    timeoutMs: config.requestTimeoutMs,
    localFallback: config.localFallback,
  });
  player = createAudioPlayer({
    onError: (message) => {
      playerError = message;
      if (tunedIn) {
        tunedIn = false;
        player?.pause();
        renderPlayerState();
      }
      renderPlayerError();
    },
    onStateChange: renderPlayerState,
  });
  audioOutputLatency = createAudioOutputLatencyMonitor();
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
  if (config.stationQueryParam || config.playbackOffsetQueryParam) {
    window.addEventListener('popstate', () => {
      if (config.stationQueryParam) {
        const station = getStationFromUrl();
        updateStationUrl(station, true);
        if (elements['station-select'].value !== station.id) loadStation(station);
      }
      if (config.playbackOffsetQueryParam) {
        playbackOffsetMs = savePlaybackOffset(getPlaybackOffsetFromUrl() ?? 0);
        renderPlaybackOffset();
        if (tunedIn) void realignPlayback();
        else render();
      }
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
  window.setInterval(syncPlayback, 50);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      clock.synchronize().then(renderClockStatus, renderClockStatus).then(() => {
        syncPlayback();
        render();
      });
    }
  });
  window.setInterval(() => {
    clock.synchronize().then(renderClockStatus).catch(renderClockStatus);
  }, config.resyncIntervalMs);
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

function getPlaybackOffsetFromUrl() {
  const value = new URL(window.location.href).searchParams.get(config.playbackOffsetQueryParam);
  return parsePlaybackOffset(value);
}

function updatePlaybackOffsetUrl(replace = false) {
  if (!config.playbackOffsetQueryParam) return;

  const url = new URL(window.location.href);
  const currentValue = url.searchParams.get(config.playbackOffsetQueryParam);
  const nextValue = playbackOffsetMs === 0 ? null : String(playbackOffsetMs);
  if (currentValue === nextValue) return;
  if (nextValue === null) url.searchParams.delete(config.playbackOffsetQueryParam);
  else url.searchParams.set(config.playbackOffsetQueryParam, nextValue);
  window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', url);
}

async function loadStation(station) {
  const loadId = ++stationLoadId;
  manifest = null;
  tunedIn = false;
  playbackCycleIndex = null;
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
      tunedIn = false;
      player.pause();
      renderPlayerState();
    }
    return;
  }

  elements['tune-button'].disabled = false;
  const position = locatePlaybackPosition(timestamp);
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
      tunedIn = false;
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

function syncPlayback() {
  if (!tunedIn || !manifest || !clock) return;
  const timestamp = clock.now();
  if (timestamp === null) {
    tunedIn = false;
    player.pause();
    renderPlayerState();
    return;
  }

  const position = locatePlaybackPosition(timestamp);
  if (!position.track) {
    tunedIn = false;
    player.pause();
    renderPlayerState();
    render();
    return;
  }
  const cycleChanged = playbackCycleIndex !== null && playbackCycleIndex !== position.cycleIndex;
  playbackCycleIndex = position.cycleIndex;
  player.sync(position.track, getPlayerOffset(position.offsetMs), cycleChanged);

  const nextTrack = manifest.tracks[position.index + 1]
    || (manifest.repeat ? manifest.tracks[0] : null);
  if (nextTrack && position.endsAt - (timestamp + playbackOffsetMs + audioOutputLatency.getCompensationMs()) <= TRACK_PRELOAD_LOOKAHEAD_MS) {
    player.preload(nextTrack);
  }
}

async function toggleTuning() {
  if (tunedIn) {
    tunedIn = false;
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
  playbackCycleIndex = position.cycleIndex;
  const previousCompensationMs = audioOutputLatency.getCompensationMs();
  const latencyMeasurement = audioOutputLatency.measure();
  try {
    await player.tune(position.track, getPlayerOffset(position.offsetMs));
    await latencyMeasurement;
    renderAudioOutputLatency();
    if (tunedIn && audioOutputLatency.getCompensationMs() !== previousCompensationMs) {
      await realignPlayback();
    }
  } catch (error) {
    tunedIn = false;
    player.pause();
    playerError = error.name === 'NotAllowedError'
      ? 'Il browser ha bloccato la riproduzione. Premi Sintonizzati per riprovare.'
      : 'Riproduzione non riuscita. Verifica che l’URL punti a un file audio diretto e accessibile.';
  }
  renderPlayerState();
  renderPlayerError();
  render();
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

function locatePlaybackPosition(timestamp) {
  return locateTrack(manifest, timestamp + playbackOffsetMs);
}

function getPlayerOffset(offsetMs) {
  return offsetMs + audioOutputLatency.getCompensationMs();
}

function changePlaybackOffset(changeMs) {
  playbackOffsetMs = savePlaybackOffset(playbackOffsetMs + changeMs);
  updatePlaybackOffsetUrl();
  renderPlaybackOffset();
  if (tunedIn) {
    void realignPlayback();
  } else {
    render();
  }
}

function renderPlaybackOffset() {
  const sign = playbackOffsetMs > 0 ? '+' : '';
  elements['playback-offset'].textContent = `${sign}${playbackOffsetMs} ms`;
  elements['offset-decrease'].disabled = playbackOffsetMs <= -MAX_PLAYBACK_OFFSET_MS;
  elements['offset-increase'].disabled = playbackOffsetMs >= MAX_PLAYBACK_OFFSET_MS;
  elements['offset-reset'].disabled = playbackOffsetMs === 0;
}

function renderPlayerState() {
  const playing = tunedIn && player?.isPlaying();
  elements['button-icon'].textContent = tunedIn ? '■' : '▶';
  elements['button-label'].textContent = tunedIn ? 'Disconnettiti' : 'Sintonizzati';
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