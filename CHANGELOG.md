# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Queue lost on pause-then-immediate-reload: the IndexedDB save is async and could be cut off by page teardown before it committed (proven in CI run 44201352963: `player.spec.ts:305` failed in chromium + mobile while the slower close/reopen test passed). Fix: synchronous localStorage write-ahead snapshot on every persist, used by restore as a fallback when IndexedDB is empty, with eager convergence back to IndexedDB. No test changed; 5 new Vitest tests for the snapshot.

### Added

- P3 database and library: IndexedDB (Dexie) port of the APK drift-v4 schema (15 stores) plus `token_index`, `playback_state`, `app_meta`, versioned v1→v2 migration with no user data loss, full LibraryService (songs, albums, artists, playlists, favorites, play history, local token-index search, search history, queue, lyrics, downloads, cache), keyset pagination 50/page, batched bulk import (1,000 sample songs in 5.6 s in-browser), queue persistence moved from localStorage to IndexedDB with one-time legacy migration (queue survives browser close/reopen), Library UI (6 tabs, local search, playlist detail, song menu, dialogs) on the black/white design lock, hidden `/library-test` seed route, 88 new Vitest tests, and 11 new Playwright E2E tests (chromium + Pixel 7). Full report in `docs/p3-database-library.md`.
- P2 player core: production player port (two `<audio>` elements, stream direct + local via Web Audio graph), PlayerService orchestrator (resolve via proxy + solver, mid-song re-resolve, stall watchdog, 3-failure stop), MediaSession metadata + handlers, queue of 200 with shuffle/repeat/speed, Zustand store, localStorage persistence, mini player bar + full player screen + queue list, "Coba pemutar" home section with the 5 real canary songs, hidden `/player-test` route (local tones), Vitest unit tests for queue/format/recovery/persistence, and Playwright E2E for play/pause/next/prev/seek/shuffle/repeat/speed/MediaSession/persistence/error retry/graph path. Full report in `docs/p2-player-core.md`.
- P0 foundation: Vite + React + TypeScript + Tailwind v4 + Zustand skeleton, black theme, home page shell, CI pipeline (typecheck, lint, unit tests, build, bundle budget gate of 200 KB gzip, Playwright E2E), and product docs in `docs/` (competitor research, extractor port notes, solver decision, architecture, PRD, phase 2 plan, team roster).
