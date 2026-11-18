# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Spike report showed only the generic failure message: `resolve()` already built per-client attempts (`WEB_REMIX=LOGIN_REQUIRED, ...`) into `ResolveError.message`, but `SpikePage` kept only the user-facing `causeText`, so the §5 report (0/5, 18 Nov 2026) could not be diagnosed without separate probing. Fix: new `SongResult.failDetail` field, shown in the copied report as a `Detail:` line (never on screen — no jargon in UI). 1 new Vitest test in `report.test.ts`.
- Queue lost on pause-then-immediate-reload: the IndexedDB save is async and could be cut off by page teardown before it committed (proven in CI run 44201352963: `player.spec.ts:305` failed in chromium + mobile while the slower close/reopen test passed). Fix: synchronous localStorage write-ahead snapshot on every persist, used by restore as a fallback when IndexedDB is empty, with eager convergence back to IndexedDB. No test changed; 5 new Vitest tests for the snapshot.

### Added

- P4 search and browse: InnerTube search (`/youtubei/v1/search`) and browse (`/youtubei/v1/browse`) via the existing proxy (no proxy change needed — the routes were already allowed), explicit-submit search only (never search-as-you-type, proven by a request counter in E2E), suggestions from history + local + network (300 ms debounce, max 8), 100-query search history in IndexedDB (reused P3 store), 6-section home page (recent, "Lagu untukmu" local formula from play history + favorites + library, most played, playlists, downloads, Jelajah with 6 h cache), full browse pages (home, artist, album, playlist, mood/genre) with play-all, bottom bar on mobile / left rail on desktop navigation, thumbnail-failure fallback to initial-letter tiles, hidden `/p4-test` seed route, 56 new Vitest tests and 26 new Playwright E2E tests (chromium + Pixel 7). Full report in `docs/p4-search-browse.md`.
- P3 database and library: IndexedDB (Dexie) port of the APK drift-v4 schema (15 stores) plus `token_index`, `playback_state`, `app_meta`, versioned v1→v2 migration with no user data loss, full LibraryService (songs, albums, artists, playlists, favorites, play history, local token-index search, search history, queue, lyrics, downloads, cache), keyset pagination 50/page, batched bulk import (1,000 sample songs in 5.6 s in-browser), queue persistence moved from localStorage to IndexedDB with one-time legacy migration (queue survives browser close/reopen), Library UI (6 tabs, local search, playlist detail, song menu, dialogs) on the black/white design lock, hidden `/library-test` seed route, 88 new Vitest tests, and 11 new Playwright E2E tests (chromium + Pixel 7). Full report in `docs/p3-database-library.md`.
- P2 player core: production player port (two `<audio>` elements, stream direct + local via Web Audio graph), PlayerService orchestrator (resolve via proxy + solver, mid-song re-resolve, stall watchdog, 3-failure stop), MediaSession metadata + handlers, queue of 200 with shuffle/repeat/speed, Zustand store, localStorage persistence, mini player bar + full player screen + queue list, "Coba pemutar" home section with the 5 real canary songs, hidden `/player-test` route (local tones), Vitest unit tests for queue/format/recovery/persistence, and Playwright E2E for play/pause/next/prev/seek/shuffle/repeat/speed/MediaSession/persistence/error retry/graph path. Full report in `docs/p2-player-core.md`.
- P0 foundation: Vite + React + TypeScript + Tailwind v4 + Zustand skeleton, black theme, home page shell, CI pipeline (typecheck, lint, unit tests, build, bundle budget gate of 200 KB gzip, Playwright E2E), and product docs in `docs/` (competitor research, extractor port notes, solver decision, architecture, PRD, phase 2 plan, team roster).
