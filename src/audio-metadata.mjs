export async function resolveTrackDurations(manifest, {
  AudioConstructor = globalThis.Audio,
  timeoutMs = 8000,
  useManifestDurations = false,
} = {}) {
  if (useManifestDurations) {
    const manifestDurations = manifest.tracks.map(({ duration }, index) => {
      if (duration === undefined || duration === null
        || (typeof duration === 'string' && duration.trim() === '')) return null;
      const durationMs = parseManifestDuration(duration);
      if (durationMs === null) {
        throw new Error(`Durata non valida per la traccia ${index + 1}: usa il formato M:SS o M:SS.mmm.`);
      }
      return durationMs;
    });
    if (manifestDurations.every((durationMs) => durationMs !== null)) {
      return {
        ...manifest,
        tracks: manifest.tracks.map((track, index) => ({
          ...track,
          durationMs: manifestDurations[index],
        })),
      };
    }
  }

  if (typeof AudioConstructor !== 'function') {
    throw new Error('Questo browser non supporta la lettura dei metadati audio.');
  }

  const tracks = await Promise.all(manifest.tracks.map(async (track, index) => {
    try {
      return { ...track, durationMs: await readTrackDuration(track.audioUrl, AudioConstructor, timeoutMs) };
    } catch (error) {
      throw new Error(`Durata non disponibile per la traccia ${index + 1} (${track.title}): ${error.message}`);
    }
  }));

  return { ...manifest, tracks };
}

function parseManifestDuration(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const milliseconds = Number((match[3] || '').padEnd(3, '0'));
  const durationMs = (minutes * 60 + seconds) * 1000 + milliseconds;
  return Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : null;
}

function readTrackDuration(audioUrl, AudioConstructor, timeoutMs) {
  return new Promise((resolve, reject) => {
    const audio = new AudioConstructor();
    audio.preload = 'metadata';

    let timeoutId;
    const cleanup = () => {
      clearTimeout(timeoutId);
      audio.removeEventListener('loadedmetadata', onMetadata);
      audio.removeEventListener('error', onError);
    };
    const fail = (message) => {
      cleanup();
      reject(new Error(message));
    };
    const onMetadata = () => {
      const durationMs = Math.round(audio.duration * 1000);
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
        fail('il file non dichiara una durata finita e positiva.');
        return;
      }
      cleanup();
      resolve(durationMs);
    };
    const onError = () => fail('impossibile caricare i metadati del file audio.');

    audio.addEventListener('loadedmetadata', onMetadata, { once: true });
    audio.addEventListener('error', onError, { once: true });
    timeoutId = setTimeout(() => fail('timeout durante il caricamento dei metadati audio.'), timeoutMs);
    audio.src = audioUrl;
    audio.load();
  });
}
