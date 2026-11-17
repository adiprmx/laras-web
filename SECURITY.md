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

Laras Web has no login of its own and no backend that stores user data, so most reports concern the web app itself: local storage in the browser, the update config it fetches from GitHub, the requests it makes to YouTube, Google, and the lyrics provider, and the optional sync Worker. Reports about YouTube, Google, or Cloudflare services belong to those providers, not here.
