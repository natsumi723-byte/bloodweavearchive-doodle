# BWA Doodle site Worker

This Worker serves the fixed public and administrator board shells from
Cloudflare Static Assets. Durable Object state and WebSockets remain owned by
the separate `worker/` deployment.

The build derives `git rev-parse HEAD` and embeds the matching immutable GitHub
tree URL in every rendered board page. Generated files are deliberately not
committed.

## Verification

```sh
npm ci
npm test
npm run deploy:dry-run
```

## Production order

1. Deploy `worker/` with its documented secrets and release variables.
2. Deploy this directory with `npm run deploy`.
3. Keep `admin-doodle.bloodweavearchive.com` covered by the owner-only
   Cloudflare Access application before exposing its DNS route.
4. Verify public and administrator hosts in both `zh-CN` and `en`.

The site build contains no production secret. Do not bypass Access or add the
administrator hostname to the public application policy.
