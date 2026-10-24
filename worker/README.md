# BWA Cloudflare board v2 candidate

Deployment candidate for `众人手记`. It targets Workers Free with one
SQLite-backed Durable Object per board and hibernatable WebSockets.

## Local run

1. Install dependencies with `npm install`.
2. Create a local secret: `npx wrangler secret put OWNERSHIP_SECRET` for a real
   deployment, or place a 32+ character value in `.dev.vars` for local testing.
3. Run `npm run dev`.

Production also requires `CORRESPONDING_SOURCE_URL` to identify the exact public
modified-source revision. The `/health` endpoint returns 503 while that value is
missing, so an upstream-only AGPL link cannot pass a production readiness check.

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

The deployable topology has three non-overlapping hosts: the Node client serves
public HTML/assets on `doodle.bloodweavearchive.com` and administrator HTML/assets
on `admin-doodle.bloodweavearchive.com`; this Worker exclusively owns
`api-doodle.bloodweavearchive.com`. Cloudflare Access protects the Worker's
`/api/admin/*` paths. In Cloudflare-authoritative mode the Node server emits an
empty board shell and never reads or inlines its local SVG history; the Durable
Object snapshot is the only persisted board baseline.
