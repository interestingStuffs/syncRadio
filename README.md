# syncRadio

syncRadio is a static web app that plays one or more configured stations against a shared UTC schedule. It needs no application backend: serve the files from any static web host.

## Run locally

Serve the repository over HTTP (ES modules and `fetch` do not work reliably from `file://`), then open the local URL:

```sh
python3 -m http.server 8000
```

Edit [`config.json`](./config.json) to configure global settings and time sources. It and the station catalog it references must be deployed with the app.

## Configure stations

Set `stationCatalogUrl` in `config.json` to the JSON file containing the stations. Each entry in its `stations` array requires a unique `id`, `name`, `description`, an ISO 8601 `timelineStartsAt` with a timezone, and a non-empty `tracks` array. Set `repeat: true` to repeat the playlist indefinitely; otherwise playback ends after the last track.

```json
{
  "stationCatalogUrl": "stations.json",
  "stations": [
    {
      "id": "radio-one",
      "name": "Radio One",
      "description": "Example station",
      "timelineStartsAt": "2026-10-07T08:00:30.000Z",
      "repeat": true,
      "tracks": [
        {
          "id": "track-1",
          "title": "Example track",
          "artist": "Example artist",
          "audioUrl": "samples/audio/example.mp3",
          "duration": "3:20"
        }
      ]
    }
  ]
}
```

The first station is selected by default. When `stationQueryParam` is set, a matching URL parameter (for example `?station=radio-one`) selects a station and browser navigation can switch between stations. The selector is shown only when `allowStationSwitch` is `true` and at least two stations are configured.

## Tracce e playlist

Tracks use `id`, `title`, `artist`, and `audioUrl`; the optional `duration` accepts `M:SS` or `M:SS.mmm`. Track IDs must be unique within each station. Audio URLs may be absolute or relative to the station catalog file and must use HTTP or HTTPS. The example catalog is [`stations.json`](./stations.json).

By default, the app reads each audio file's duration from its metadata. With `useManifestDurations: true`, it uses manifest durations only when every track has a valid duration; if any duration is missing, it reads metadata for the whole playlist. A supplied but invalid duration is reported as an error.

## Clock and playback

`timeSources` is an ordered list of UTC time providers. Each provider specifies `name`, `url`, and `responsePath`; optionally set `timeZonePath` or `responseFormat` (`json` or `text`). Providers are tried in order. An optional `customTimeSource` is tried first when its URL is non-empty. Set `customTimeSourceOnly: true` to use only that source and never try providers from `timeSources`; if the custom URL is empty, no time provider is used.

The app periodically samples the active provider, estimates UTC using the browser's monotonic clock, and uses the device clock only when `localFallback` is enabled. By default, clock resynchronization runs at the interval configured by `resyncIntervalMs`; set `resyncOnTrackChangeOnly: true` to resynchronize only when the scheduled track changes instead. Time providers, manifests, and audio files must be reachable by the browser; cross-origin resources must allow CORS. Browser timer throttling, network delay, and audio-device buffering mean exact synchronization cannot be guaranteed.

The player uses Web Audio to fetch, decode, and schedule tracks against the shared timeline. It preloads the next track, adjusts playback against the schedule, and optionally estimates audio output latency. Set `enableOutputLatencyCompensation` to `false` in `config.json` to measure output latency without applying compensation, for an A/B comparison; it defaults to `true`. Set `showPlaybackOffsetControls` to `false` to hide the manual offset controls; it defaults to `true`. `playbackSyncIntervalMs` controls how often playback is checked (10–1000 ms; default 50 ms). The advanced synchronization panel reports the effective check interval and, over the last 60 seconds, the measured playback drift and corrections that exceeded the 10 ms tolerance. Schedule times are displayed in the viewer's local time zone; for repeating playlists, the current track and the track just played show their next scheduled occurrence after the duration. Since Web Audio decodes complete tracks into memory, keep audio files reasonably sized. Audio files must allow cross-origin `fetch` requests when hosted on a different origin. The manual playback offset is stored in the browser and is not shared between devices.

## Tests and modules

Run the tests with Node.js:

```sh
node --test
```

Core logic is separated into modules: `clock.mjs` handles UTC synchronization, `timeline.mjs` maps time to tracks, `data-source.mjs` loads and validates the station catalog, `audio-metadata.mjs` resolves track durations, and `player.mjs` schedules playback with Web Audio. `app.mjs` connects these modules to the page.
