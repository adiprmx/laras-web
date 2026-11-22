# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes, once released |
| 0.9.x   | Test builds only; fixes land in the next test build or in 1.0.0 |

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately so it can be fixed before the details spread.

Contact: adiprmx@gmail.com

Do not post vulnerability details in a public issue or discussion.

A good report includes:

- What the problem is, in plain words.
- The app version and the browser where you saw it.
- Steps to reproduce it.
- What an attacker could do with it, as far as you can tell.

Do not include stream URLs, full network responses, account details, or other people's data in the report.

## What happens after you report

The maintainer confirms receipt, investigates, and fixes the issue in a new release. The fix ships with a note in the changelog. There is no promised response time; this is a one-maintainer project, and the maintainer answers as soon as they can.

## Scope notes

Login is optional and only for sync: the user signs in with GitHub or Google OAuth, and only after turning sync on. Playing music never needs a login. When sync is on, the sync Worker stores the user's library data (playlists, likes, history) in a Cloudflare D1 database so it can follow the user across devices. The app does not store OAuth access tokens, and the OAuth scopes do not request the user's email. The user can delete the synced account from Settings; deletion also removes the stored library data after a short re-registration cooldown.

So most reports concern the web app itself: local storage in the browser, the update config it fetches from GitHub, the requests it makes to YouTube, Google, and the lyrics provider, and the optional sync Worker and its stored library data. Reports about YouTube, Google, or Cloudflare services belong to those providers, not here.
