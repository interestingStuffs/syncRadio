export async function loadStationCatalog(url, timeoutMs = 8000) {
  if (!url) throw new Error('Configura stationCatalogUrl in config.json.');

  let response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('Timeout durante il caricamento del catalogo delle stazioni.');
    throw new Error('Catalogo delle stazioni non raggiungibile. Verifica URL, connessione e permessi CORS.');
  }

  if (!response.ok) throw new Error(`Catalogo delle stazioni non disponibile (HTTP ${response.status}).`);
  const text = await response.text();
  try {
    return validateStationCatalog(JSON.parse(text), new URL(url, document.baseURI).href);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Il catalogo delle stazioni non contiene JSON valido.');
    throw error;
  }
}

export function validateStationCatalog(value, catalogUrl = document.baseURI) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Il catalogo delle stazioni deve contenere una lista di stazioni.');
  }
  if (!Array.isArray(value.stations) || value.stations.length === 0) {
    throw new Error('Il catalogo deve contenere almeno una stazione.');
  }

  const ids = new Set();
  return value.stations.map((station, index) => {
    const label = `stations[${index}]`;
    if (!station || typeof station !== 'object' || Array.isArray(station)) {
      throw new Error(`${label} deve essere un oggetto.`);
    }
    const id = requiredText(station.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`Identificativo duplicato nel catalogo delle stazioni: ${id}.`);
    ids.add(id);

    const name = requiredText(station.name, `${label}.name`);
    const description = requiredText(station.description, `${label}.description`);
    const timelineStartsAt = requiredText(station.timelineStartsAt, `${label}.timelineStartsAt`);
    if (station.repeat !== undefined && typeof station.repeat !== 'boolean') {
      throw new Error(`${label}.repeat deve essere true o false.`);
    }

    const { tracks } = validateStationTracks(station, timelineStartsAt, catalogUrl);
    return {
      id,
      name,
      description,
      timelineStartsAt,
      repeat: station.repeat === true,
      tracks,
    };
  });
}

function validateStationTracks(value, timelineStartsAt, baseUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('La stazione deve contenere una lista di tracce.');
  }

  const startsAt = requiredText(timelineStartsAt, 'timelineStartsAt della stazione');
  if (!hasTimezone(startsAt) || !Number.isFinite(Date.parse(startsAt))) {
    throw new Error('timelineStartsAt della stazione deve essere una data ISO 8601 valida con fuso orario.');
  }
  if (!Array.isArray(value.tracks) || value.tracks.length === 0) {
    throw new Error('La stazione deve contenere almeno una traccia.');
  }

  const ids = new Set();
  const tracks = value.tracks.map((track, index) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) {
      throw new Error(`La traccia ${index + 1} non è un oggetto valido.`);
    }
    const id = requiredText(track.id, `identificativo della traccia ${index + 1}`);
    if (ids.has(id)) throw new Error(`Identificativo duplicato nella scaletta: ${id}.`);
    ids.add(id);

    const audioUrl = requiredText(track.audioUrl, `URL audio della traccia ${index + 1}`);
    let parsedAudioUrl;
    try {
      parsedAudioUrl = new URL(audioUrl, baseUrl);
    } catch {
      throw new Error(`URL audio non valido nella traccia ${index + 1}.`);
    }
    if (!['http:', 'https:'].includes(parsedAudioUrl.protocol)) {
      throw new Error(`La traccia ${index + 1} deve usare un URL audio HTTP o HTTPS.`);
    }

    const validatedTrack = {
      id,
      title: requiredText(track.title, `titolo della traccia ${index + 1}`),
      artist: requiredText(track.artist, `artista della traccia ${index + 1}`),
      audioUrl: parsedAudioUrl.href,
    };
    if (Object.hasOwn(track, 'duration')) validatedTrack.duration = track.duration;
    return validatedTrack;
  });

  return {
    timelineStartsAt: startsAt,
    tracks,
  };
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Campo obbligatorio mancante: ${label}.`);
  return value.trim();
}

function hasTimezone(value) {
  return /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}