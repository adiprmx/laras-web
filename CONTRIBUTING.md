# Contributing to Laras Web

Thank you for reading this before you start. Laras is a small project with one maintainer, so a little care up front saves a lot of back and forth.

## Ground rules

- Be kind. The [Code of Conduct](CODE_OF_CONDUCT.md) applies to every interaction here.
- Do not copy code from other music apps (InnerTune, OuterTune, ViMusic, SimpMusic, Spotube, or similar). Write from the spec, not from their source. If you study how they behave, write your own implementation. Porting from the sibling repo [adiprmx/laras](https://github.com/adiprmx/laras) (the Android app, same author) is allowed and expected; the port notes live in `docs/transfer-ekstraktor.md`.
- Do not touch the Spotify API in any form. No calls to Spotify domains, no Spotify login, no Spotify wrapper library. The only Spotify-related work allowed is import from a file the user owns, as specified in the product docs.
- Do not add a mandatory login, telemetry, ads, or payment. v1 has none of these by design. An optional account exists only for sync, and only after the user turns it on.
- Do not add a secret, token, password, or key to the repo. Secrets live only in GitHub Actions secrets or in the Cloudflare dashboard.
- Keep user-facing text in plain, everyday Indonesian. No technical terms on screen, no invented numbers, no claims the app cannot prove.
- Keep the initial bundle small. CI fails if the initial JavaScript bundle goes over 200 KB (gzip).

## Before you write code

- For a bug fix, open an issue first or pick an existing one, so work does not collide.
- For a feature, open an issue and wait for the maintainer to agree on the scope. Unplanned features get closed, even good ones, because scope is frozen after milestone P4.
- Read the product docs in `docs/` (PRD, architecture, UI spec) when your change touches behavior, copy, or design tokens. If the docs and the code disagree, ask in the issue instead of guessing.

## Workflow

1. Fork the repo and create a branch from `main`. One branch per change.
2. Make the change. Keep it focused: one issue, one pull request.
3. Add or update tests for behavior you changed. Pure logic needs unit tests (Vitest). A screen needs a Playwright test for the states it can show (loading, empty, error, offline) where relevant.
4. Run the checks below locally. CI runs the same checks and fails on any warning.
5. Open a pull request against `main` and fill in the template. Describe what changed, why, and how you tested it.

## Checks (must pass before you open a PR)

```sh
cd app
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:e2e
```

- `npm run typecheck` and `npm run lint` must report zero warnings. A warning is a failure.
- New user-facing strings go in the copy module for the screen. Do not hardcode strings scattered in components.
- New screens follow the design tokens in `app/src/index.css` and `docs/arsitektur.md`. Do not invent colors, radii, or font sizes inline.
- Keep the bundle small. CI fails if the initial JavaScript bundle goes over 200 KB (gzip).

## Commit messages

Write short, plain commit messages in English, in the imperative mood:

- `Add download queue screen`
- `Fix queue losing position after restart`
- `Update changelog for 0.9.0`

One logical change per commit. Do not mix a refactor with a behavior change in one commit.

## Reporting bugs and asking for features

Use the issue templates. A bug report needs the app version, the browser and version, the device, the steps that led to the bug, and what you saw instead. Screenshots of the actual symptom help more than a description from memory.

Do not paste stream URLs, full network responses, or anything that identifies your account into an issue. The app never has your login, and issue reports should stay that way too.

## License

By contributing, you agree that your contribution is licensed under the GPL-3.0-only, the same license as the rest of Laras.
