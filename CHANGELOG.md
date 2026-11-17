# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- P2 player core: production player port (two `<audio>` elements, stream direct + local via Web Audio graph), PlayerService orchestrator (resolve via proxy + solver, mid-song re-resolve, stall watchdog, 3-failure stop), MediaSession metadata + handlers, queue of 200 with shuffle/repeat/speed, Zustand store, localStorage persistence, mini player bar + full player screen + queue list, "Coba pemutar" home section with the 5 real canary songs, hidden `/player-test` route (local tones), Vitest unit tests for queue/format/recovery/persistence, and Playwright E2E for play/pause/next/prev/seek/shuffle/repeat/speed/MediaSession/persistence/error retry/graph path. Full report in `docs/p2-player-core.md`.
- P0 foundation: Vite + React + TypeScript + Tailwind v4 + Zustand skeleton, black theme, home page shell, CI pipeline (typecheck, lint, unit tests, build, bundle budget gate of 200 KB gzip, Playwright E2E), and product docs in `docs/` (competitor research, extractor port notes, solver decision, architecture, PRD, phase 2 plan, team roster).
