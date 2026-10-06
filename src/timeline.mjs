export function locateTrack(manifest, timestamp) {
  const startsAt = Date.parse(manifest.timelineStartsAt);
  const elapsedMs = timestamp - startsAt;
  const cycleDurationMs = manifest.tracks.reduce((total, track) => total + track.durationMs, 0);
  const repeats = manifest.repeat === true && elapsedMs >= 0;
  const cycleIndex = repeats ? Math.floor(elapsedMs / cycleDurationMs) : 0;
  const cycleOffsetMs = repeats ? elapsedMs % cycleDurationMs : elapsedMs;
  let cursor = startsAt + cycleIndex * cycleDurationMs;
  let cycleCursor = 0;

  for (let index = 0; index < manifest.tracks.length; index += 1) {
    const track = manifest.tracks[index];
    const endsAt = cursor + track.durationMs;
    if (cycleOffsetMs >= cycleCursor && cycleOffsetMs < cycleCursor + track.durationMs) {
      return {
        index,
        track,
        startsAt: cursor,
        endsAt,
        offsetMs: cycleOffsetMs - cycleCursor,
        elapsedMs,
        cycleIndex,
      };
    }
    cursor = endsAt;
    cycleCursor += track.durationMs;
  }

  return {
    index: -1,
    track: null,
    startsAt: null,
    endsAt: null,
    offsetMs: 0,
    elapsedMs,
    cycleIndex,
  };
}

export function buildSchedule(manifest) {
  let cursor = Date.parse(manifest.timelineStartsAt);
  return manifest.tracks.map((track, index) => {
    const startsAt = cursor;
    cursor += track.durationMs;
    return { track, index, startsAt, endsAt: cursor };
  });
}