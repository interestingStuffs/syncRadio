export async function loadStationManifest(url, timelineStartsAt, timeoutMs = 8000) {
  if (!url) throw new Error('Configura manifestUrl della stazione in config.json.');

  let response;
  try {
    response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new Error('Timeout durante il caricamento del manifesto.');
    throw new Error('Manifesto non raggiungibile. Verifica URL, connessione e permessi CORS.');
  }

  if (!response.ok) throw new Error(`Manifesto non disponibile (HTTP ${response.status}).`);
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const isCsv = /(?:text\/csv|application\/csv)/i.test(contentType) || /\.csv(?:$|[?#])/i.test(url);
  let manifest;

  try {
    manifest = isCsv ? parseCsvManifest(text) : JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Il manifesto non contiene JSON valido. Per il CSV usa le intestazioni documentate.');
    throw error;
  }

  return validateManifest(manifest, timelineStartsAt);
}

export function validateManifest(value, timelineStartsAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Il manifesto deve contenere una lista di tracce.');
  }

  const startsAt = requiredText(timelineStartsAt, 'timelineStartsAt della stazione in config.json');
  if (!hasTimezone(startsAt) || !Number.isFinite(Date.parse(startsAt))) {
    throw new Error('timelineStartsAt della stazione deve essere una data ISO 8601 valida con fuso orario, ad esempio UTC con Z.');
  }
  if (!Array.isArray(value.tracks) || value.tracks.length === 0) {
    throw new Error('Il manifesto deve contenere almeno una traccia ufficiale.');
  }

  const ids = new Set();
  const tracks = value.tracks.map((track, index) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) {
      throw new Error(`La traccia ${index + 1} non è un oggetto valido.`);
    }
    const id = requiredText(track.id, `identificativo della traccia ${index + 1}`);
    if (ids.has(id)) throw new Error(`Identificativo duplicato nel manifesto: ${id}.`);
    ids.add(id);

    const audioUrl = requiredText(track.audioUrl, `URL audio della traccia ${index + 1}`);
    let parsedAudioUrl;
    try {
      parsedAudioUrl = new URL(audioUrl, document.baseURI);
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

export function parseCsvManifest(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw new Error('Il CSV deve contenere intestazioni e almeno una traccia.');

  const headers = rows.shift().map((header) => header.trim().replace(/^\uFEFF/, ''));
  const requiredHeaders = ['id', 'title', 'artist', 'audioUrl'];
  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  const missingHeaders = requiredHeaders.filter((header) => !headerIndexes.has(header));
  if (missingHeaders.length) throw new Error(`Intestazioni CSV mancanti: ${missingHeaders.join(', ')}.`);

  const records = rows.filter((row) => row.some((cell) => cell.trim() !== ''));
  if (records.length === 0) throw new Error('Il CSV non contiene tracce.');
  const field = (row, key) => (row[headerIndexes.get(key)] || '').trim();

  return {
    tracks: records.map((row) => {
      const track = {
        id: field(row, 'id'),
        title: field(row, 'title'),
        artist: field(row, 'artist'),
        audioUrl: field(row, 'audioUrl'),
      };
      if (headerIndexes.has('duration')) track.duration = field(row, 'duration');
      return track;
    }),
  };
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (char === '\r' && input[index + 1] === '\n') index += 1;
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('Il CSV contiene un campo tra virgolette non chiuso.');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Campo obbligatorio mancante: ${label}.`);
  return value.trim();
}

function hasTimezone(value) {
  return /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}