import { MAX_PLAYBACK_OFFSET_MS } from './playback-offset.mjs';

export function parseHostAudioOffset(value) {
  if (typeof value !== 'string' || value.trim() === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(MAX_PLAYBACK_OFFSET_MS, Math.max(-MAX_PLAYBACK_OFFSET_MS, Math.round(parsed)));
}
