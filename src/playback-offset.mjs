export const PLAYBACK_OFFSET_STEP_MS = 50;
export const MAX_PLAYBACK_OFFSET_MS = 5000;

const STORAGE_KEY = 'syncRadio.playbackOffsetMs';

export function loadPlaybackOffset(storage = getStorage()) {
  if (!storage) return 0;
  try {
    const value = Number(storage.getItem(STORAGE_KEY));
    return Number.isFinite(value) ? clampOffset(Math.round(value)) : 0;
  } catch {
    return 0;
  }
}

export function savePlaybackOffset(value, storage = getStorage()) {
  const offset = Number.isFinite(value) ? clampOffset(Math.round(value)) : 0;
  try {
    storage?.setItem(STORAGE_KEY, String(offset));
  } catch {
    // Keep the current page usable when browser storage is unavailable.
  }
  return offset;
}

function clampOffset(value) {
  return Math.min(MAX_PLAYBACK_OFFSET_MS, Math.max(-MAX_PLAYBACK_OFFSET_MS, value));
}

function getStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}