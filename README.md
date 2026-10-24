# Bloodweave Archive — The Unfinished Archive

Corresponding source for the collaborative drawing board published by
Bloodweave Archive.

This repository contains three deployable applications:

- `client/`: the modified Whitebophir client and local server integration;
- `worker/`: the Cloudflare Worker, SQLite-backed Durable Object, ownership
  enforcement, administrator routes, and scheduled Google Drive backup logic.
- `site-worker/`: the Cloudflare Static Assets Worker for the public and
  Access-protected administrator HTML shells and browser assets.

## Development

Requirements: Node.js 22 or newer.

```sh
cd client
npm ci
npm run test-node
npm run typecheck
npm run lint:t42
```

```sh
cd worker
npm ci
npm test
npm run deploy:dry-run
```

```sh
cd site-worker
npm ci
npm test
npm run deploy:dry-run
```

The Worker configuration intentionally contains no production secrets. Never
commit `.dev.vars`, OAuth credentials, administrator secrets, ownership
secrets, Cloudflare tokens, or exported board data.

## Deployment identity

The Worker and site deployment wrappers derive `RELEASE_GIT_SHA` and the exact
immutable GitHub tree URL from `git rev-parse HEAD`. The renderer passes the
matching identity into the browser shell. A moving branch URL or mismatched
release identity is rejected.

Public board origin:

`https://doodle.bloodweavearchive.com`

Administrator origin, protected separately by Cloudflare Access:

`https://admin-doodle.bloodweavearchive.com`

Worker API/WebSocket origin:

`https://api-doodle.bloodweavearchive.com`

## Upstream and license

The client is derived from
[Whitebophir](https://github.com/lovasoa/whitebophir), which is licensed under
the GNU Affero General Public License, version 3 or later. This corresponding
source package is distributed under the same license. See `LICENSE` and
`AUTHORS`.
