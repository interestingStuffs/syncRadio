const DEFAULT_TIMEOUT_MS = 8000;

export async function loadConfig() {
  const response = await fetch('./config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Impossibile caricare config.json (HTTP ${response.status}).`);

  let config;
  try {
    config = await response.json();
  } catch {
    throw new Error('config.json non contiene JSON valido.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config.json deve contenere un oggetto JSON.');
  }

  const stations = validateStations(config.stations);
  const timeSources = config.timeSources === undefined ? [] : validateTimeSources(config.timeSources);
  if (config.localFallback !== undefined && typeof config.localFallback !== 'boolean') {
    throw new Error('Il valore "localFallback" in config.json deve essere true o false.');
  }
  if (config.allowStationSwitch !== undefined && typeof config.allowStationSwitch !== 'boolean') {
    throw new Error('Il valore "allowStationSwitch" in config.json deve essere true o false.');
  }
  if (config.useManifestDurations !== undefined && typeof config.useManifestDurations !== 'boolean') {
    throw new Error('Il valore "useManifestDurations" in config.json deve essere true o false.');
  }

  return {
    stations,
    allowStationSwitch: config.allowStationSwitch === true,
    useManifestDurations: config.useManifestDurations === true,
    timeSources,
    resyncIntervalMs: positiveNumber(config.resyncIntervalMs, 30000),
    requestTimeoutMs: positiveNumber(config.requestTimeoutMs, DEFAULT_TIMEOUT_MS),
    localFallback: config.localFallback !== false,
  };
}

function validateStations(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('stations in config.json deve essere una lista contenente almeno una stazione.');
  }

  const ids = new Set();
  return value.map((station, index) => {
    const label = `stations[${index}]`;
    if (!station || typeof station !== 'object' || Array.isArray(station)) {
      throw new Error(`${label} deve essere un oggetto.`);
    }

    const id = requireString(station.id, `${label}.id`);
    const name = requireString(station.name, `${label}.name`);
    const description = requireString(station.description, `${label}.description`);
    const manifestUrl = requireString(station.manifestUrl, `${label}.manifestUrl`);
    const timelineStartsAt = requireString(station.timelineStartsAt, `${label}.timelineStartsAt`);
    if (station.repeat !== undefined && typeof station.repeat !== 'boolean') {
      throw new Error(`${label}.repeat deve essere true o false.`);
    }
    if (!id || !name || !description || !manifestUrl || !timelineStartsAt) {
      throw new Error(`${label} richiede id, name, description, manifestUrl e timelineStartsAt.`);
    }
    if (!hasTimezone(timelineStartsAt) || !Number.isFinite(Date.parse(timelineStartsAt))) {
      throw new Error(`${label}.timelineStartsAt deve essere una data ISO 8601 valida con fuso orario.`);
    }
    if (ids.has(id)) throw new Error(`Identificativo duplicato in config.json: ${id}.`);
    ids.add(id);

    return { id, name, description, manifestUrl, timelineStartsAt, repeat: station.repeat === true };
  });
}

function requireString(value, name) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error(`Il valore "${name}" in config.json deve essere una stringa.`);
  return value.trim();
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hasTimezone(value) {
  return /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}

function validateTimeSources(value) {
  if (!Array.isArray(value)) throw new Error('timeSources in config.json deve essere una lista ordinata.');
  return value.map((source, index) => {
    const label = `timeSources[${index}]`;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`${label} deve essere un oggetto.`);
    }

    const name = requireString(source.name, `${label}.name`);
    const url = requireString(source.url, `${label}.url`);
    const responsePath = requireString(source.responsePath, `${label}.responsePath`);
    const timeZonePath = requireString(source.timeZonePath ?? '', `${label}.timeZonePath`);
    if (!name || !url) throw new Error(`${label} richiede name e url.`);

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`${label}.url deve essere un URL assoluto valido.`);
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`${label}.url deve usare HTTP o HTTPS.`);
    }

    return { name, url: parsedUrl.href, responsePath, timeZonePath };
  });
}