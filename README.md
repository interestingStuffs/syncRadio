# syncRadio

syncRadio is a static web app that plays one or more configured stations against a shared UTC schedule. It needs no application backend: serve the files from any static web host.

## Run locally

Serve the repository over HTTP (ES modules and `fetch` do not work reliably from `file://`), then open the local URL:

```sh
python3 -m http.server 8000
```

Edit [`config.json`](./config.json) to configure stations and time sources. It is part of this repository and must be deployed with the app.

## Configure stations

Each entry in `stations` requires a unique `id`, `name`, `description`, `manifestUrl`, and an ISO 8601 `timelineStartsAt` with a timezone. Set `repeat: true` to repeat the playlist indefinitely; otherwise playback ends after the last track.

```json
{
  "allowStationSwitch": true,
  "stationQueryParam": "station",
  "stations": [
    {
      "id": "radio-one",
      "name": "Radio One",
      "description": "Example station",
      "manifestUrl": "samples/station-1.csv",
      "timelineStartsAt": "2026-10-07T08:00:30.000Z",
      "repeat": true
    }
  ]
}
```

The first station is selected by default. When `stationQueryParam` is set, a matching URL parameter (for example `?station=radio-one`) selects a station and browser navigation can switch between stations. The selector is shown only when `allowStationSwitch` is `true` and at least two stations are configured.

## Playlist manifests

CSV is recommended. The repository includes [`samples/station-1.csv`](./samples/station-1.csv), [`samples/station-2.csv`](./samples/station-2.csv), and [`samples/station-3.csv`](./samples/station-3.csv). CSV headers must include `id,title,artist,audioUrl`; the optional `duration` column accepts `M:SS` or `M:SS.mmm`.

JSON manifests are also supported and use a top-level `tracks` array with the same fields. Track IDs must be unique within a manifest. Audio URLs may be absolute or relative to the page and must use HTTP or HTTPS.

By default, the app reads each audio file's duration from its metadata. With `useManifestDurations: true`, it uses manifest durations only when every track has a valid duration; if any duration is missing, it reads metadata for the whole playlist. A supplied but invalid duration is reported as an error.

## Clock and playback

`timeSources` is an ordered list of UTC time providers. Each provider specifies `name`, `url`, and `responsePath`; optionally set `timeZonePath` or `responseFormat` (`json` or `text`). Providers are tried in order. An optional `customTimeSource` is tried first when its URL is non-empty.

The app periodically samples the active provider, estimates UTC using the browser's monotonic clock, and uses the device clock only when `localFallback` is enabled. Time providers, manifests, and audio files must be reachable by the browser; cross-origin resources must allow CORS. Browser timer throttling, network delay, and audio-device buffering mean exact synchronization cannot be guaranteed.

The player can preload the next track, adjust playback against the schedule, and optionally estimate audio output latency. The manual playback offset is stored in the browser and is not shared between devices.

## Tests and modules

Run the tests with Node.js:

```sh
node --test
```

Core logic is separated into modules: `clock.mjs` handles UTC synchronization, `timeline.mjs` maps time to tracks, `data-source.mjs` loads and validates manifests, `audio-metadata.mjs` resolves track durations, and `player.mjs` controls HTML audio. `app.mjs` connects these modules to the page.
