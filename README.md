# Bloodweave Archive — The Unfinished Archive

Corresponding source for the collaborative drawing board published by
Bloodweave Archive.

This repository contains two applications:

- `client/`: the modified Whitebophir client and local server integration;
- `worker/`: the Cloudflare Worker, SQLite-backed Durable Object, ownership
  enforcement, administrator routes, and scheduled Google Drive backup logic.

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
```

The Worker configuration intentionally contains no production secrets. Never
commit `.dev.vars`, OAuth credentials, administrator secrets, ownership
secrets, Cloudflare tokens, or exported board data.

## Deployment identity

Production builds must set `RELEASE_GIT_SHA` and `CORRESPONDING_SOURCE_URL` to
the immutable GitHub URL for that exact deployed commit. The Node client uses
the matching `WBO_RELEASE_GIT_SHA` and `WBO_CORRESPONDING_SOURCE_URL` values.
A moving branch URL is rejected by both runtimes.

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
