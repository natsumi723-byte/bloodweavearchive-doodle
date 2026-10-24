# BWA Cloudflare board v2 candidate

Deployment candidate for `众人手记`. It targets Workers Free with one
SQLite-backed Durable Object per board and hibernatable WebSockets.

## Local run

1. Install dependencies with `npm install`.
2. Create a local secret: `npx wrangler secret put OWNERSHIP_SECRET` for a real
   deployment, or place a 32+ character value in `.dev.vars` for local testing.
3. Run `npm run dev`.

## Reproducible local release fixtures

The release package includes three self-contained local fixtures. They generate
fresh non-production credentials in memory, start `wrangler dev --local` on a
free loopback port, and remove the process afterwards. They never read or write
production secrets. The ownership and browser fixtures use
`ALLOW_MISSING_ACCESS_ASSERTION=true` only in their local test processes. The
Access fixture instead uses HTTPS, an ephemeral RSA key, and a local JWK set to
exercise the real JWT verification path without that bypass.

After `npm ci`, run:
- `npm run check:ownership-integration` for a fresh unique-board public/admin
  WebSocket run covering owner isolation, administrator delete/move,
  idempotent acknowledgement and persisted replay.
- `npm run check:access-jwt-integration` for real HTTPS Worker requests proving
  that a valid Access assertion succeeds while wrong-audience, expired and
  missing assertions fail closed.
- `npx playwright install chromium` once, then
  `npm run check:admin-browser-e2e` for a real browser on a separate loopback
  origin. It exercises the HTTPS Worker `OPTIONS` preflight, origin check,
  local Access bypass, Bearer verification and export/restore/purge routes,
  including cancel, failure and success. Restore success is followed through
  navigation and reconnection, then verified by a second export and public
  owner/non-owner deletion checks.

Both commands print one JSON result containing their unique board and local
endpoint/origin. `ALLOW_MISSING_ACCESS_ASSERTION` is absent from
`wrangler.jsonc`; production configuration rejects both this bypass and local
JWK input, so neither test-only mechanism can enable a deployed Worker.

Use `npm run deploy:dry-run` or `npm run deploy`. The wrapper derives the exact
current commit and immutable public tree URL and supplies both release identity
bindings to Wrangler. The `/health` endpoint returns 503 when that identity is
missing or mismatched, so an upstream-only or moving AGPL link cannot pass.

The public WebSocket endpoint is `/api/boards/<board-id>/socket`. Clients connect with
the subprotocol list `["bwa-v2", "owner.<token>"]`, where `<token>` is a
browser-generated URL-safe random token. This keeps ownership credentials out of
URLs and ordinary access logs; the server selects only `bwa-v2` in its response.

`ALLOWED_PUBLIC_ORIGINS` and `ALLOWED_ADMIN_ORIGINS` are mandatory in
production and are matched exactly and independently. The
administrator connects only through `/api/admin/boards/<board-id>/socket` from
the separate `admin-doodle.bloodweavearchive.com` origin. That hostname/path
must be protected by a Cloudflare Access application before deployment. The
Worker also requires the Access assertion header and rejects admin credentials
on the public socket route. `ADMIN_SECRET` remains a second factor; it does not
replace Access.

The same Access boundary protects manual `GET .../export`, `POST .../restore`,
and `POST .../purge` routes. Export returns a portable snapshot plus SHA-256
manifest. Restore verifies the manifest and board identity before replacing
board storage. Purge permanently removes only tombstones older than 30 days.

For local reliability tests only, `ENABLE_TEST_FAULTS=true` makes a board whose
name begins with `qa-lost-ack-` commit its first durable mutation and close the
socket before returning the ACK. The flag is absent from production config and
must never be configured in a deployed Worker.

Each completed stroke is one SQL row and one durable write. Cursor messages are
ephemeral. Deletion succeeds only when the board-scoped HMAC of the current
browser token matches the stored owner hash. IP addresses are not stored or used
for ownership.

The deployable topology has three non-overlapping hosts: `site-worker/` serves
public HTML/assets on `doodle.bloodweavearchive.com` and administrator
HTML/assets on `admin-doodle.bloodweavearchive.com`; this Worker exclusively
owns `api-doodle.bloodweavearchive.com`. Cloudflare Access protects the
administrator host and the Worker's `/api/admin/*` paths. The generated browser
shell starts with an empty SVG and the Durable Object WebSocket snapshot is the
only persisted board baseline.
