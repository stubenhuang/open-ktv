# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

本文件记录 Open KTV 的所有显著变更，格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/spec/v2.0.0.html)。

## [Unreleased]

### Added

- **Internationalisation (i18n).** Every user-facing string now goes through a typed catalogue
  in `web/src/i18n/`. `zh-CN` (reference) and `en` ship by default; the language can be
  switched from the navigation bar (desktop) or the mobile top bar, is remembered in
  `localStorage`, can be forced with `?lang=`, and is mirrored onto `<html lang>`.
  Number, duration, file-size, date and list formatting uses `Intl` instead of hand-built
  strings, and title sorting follows the interface language's collation.
  See [docs/i18n.md](docs/i18n.md).
- **Language-neutral API errors.** Endpoints return a machine-readable `code` plus structured
  `params`; the client renders them in the reader's locale. `GET /api/network` likewise reports
  `reasonCode` instead of a sentence. See `ApiErrorCode` in `shared/types.ts` and `errors.ts`
  in each locale.
- `npm run check:i18n` — validates catalogue parity, placeholder consistency, server error-code
  alignment, and that every key used in the source exists. Runs in CI.
- `npm run check:license` — validates that every source file carries an
  `SPDX-License-Identifier: MIT` header. Runs in CI.
- Open-source community files: [CONTRIBUTING.md](CONTRIBUTING.md),
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [SECURITY.md](SECURITY.md),
  [docs/i18n.md](docs/i18n.md), issue and pull-request templates, and `FUNDING.yml`.
- Package metadata (`license`, `repository`, `bugs`, `homepage`, `keywords`, `files`,
  `funding`) so the MIT licence is discoverable from the manifest.
- `web/src/i18n/labels.ts` — locale-aware names for the shared mix vocabulary (presets, reverb
  spaces, pitch, reverb summary), so the UI no longer renders the server-log Chinese labels.

### Changed

- `package.json` no longer marks the project `private`, and declares an explicit `files`
  allow-list for publishing.
- `web/src/utils.ts` formatting helpers (`formatBytes`, `formatDateTime`,
  `formatRelativeTime`) are now thin wrappers over the single `Intl` implementation in
  `web/src/i18n/format.ts`, and take a `locale` parameter.
- `NetworkInfo.reason` → `NetworkInfo.reasonCode` (machine-readable).
- `withRecord`'s `notFound` option takes an `ApiErrorCode` instead of a hardcoded sentence.
- Title sorting in the library and works lists uses the active locale's collation rather than
  a hardcoded `zh-Hans-CN`.
- `scripts/e2e-browser.mjs` pins the interface language to `zh-CN` via `?lang=`, because it
  asserts on Chinese UI text.

### Removed

- `rubberbandMissingMessage()` from `server/src/pitch.ts` — the message now lives in the
  catalogue as `error.pitch_rubberband_missing`.

### Fixed

- —

## [0.1.0]

### Added

- Backing-track library: multi-file upload (audio required, `.lrc` optional), list preview,
  edit dialog (title / artist / lyrics / offset / pitch), delete.
- Built-in 5sing backing-track source (enabled by default) plus optional self-hosted manifests
  through `LIBRARY_SOURCES`.
- Kugou lyric matching on import and on demand.
- LRC parsing (`[mm:ss.xx]`, multi-timestamp, `[offset:]`), karaoke-style per-character
  fill, next-line preview, per-line seek.
- Transcoding proxies for formats the browser cannot play directly (`ape`, `wma`, `ogg`, …).
- Pitch shifting of the backing track, ±12 semitones, via ffmpeg `rubberband`; the shifted
  file is the one used for monitoring, preview and the final mix.
- Singing page: external-input device picker, live level meter, backing / monitor volume,
  monitor mute, full-screen lyric stage with auto-alignment.
- Mobile singing at `/m` over the LAN: QR entry, self-signed HTTPS mirror, three tabs
  (tracks / discover / works).
- Mixing: vocal and backing loudness normalisation, ten named presets, three-band EQ,
  continuous reverb (space + wetness) with an IR shared between the browser preview and the
  server-side ffmpeg convolution, optional compression / de-esser / denoise, ±1000 ms
  alignment trim.
- Works library: search, sort, status filter, inline rename, embedded playback, MP3 / dry-WAV
  download, retry mix.
- Segment re-take: replace one line on the dry-vocal timeline, server-side splice with a
  20 ms cross-fade, automatic re-mix, one-level undo.
- Ops: graceful shutdown, log rotation, disk-space pre-flight, `openktv.sh` service script,
  `backup` command based on `VACUUM INTO`, GitHub Actions CI.
