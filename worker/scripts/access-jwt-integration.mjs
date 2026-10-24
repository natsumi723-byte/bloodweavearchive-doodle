import assert from "node:assert/strict";
import https from "node:https";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { reservePort, startLocalWorker } from "./local-worker-fixture.mjs";

const { privateKey, publicKey } = await generateKeyPair("RS256", {
	extractable: true,
});
const publicJwk = await exportJWK(publicKey);
publicJwk.kid = "local-access-fixture";
publicJwk.alg = "RS256";
publicJwk.use = "sig";
const issuer = "https://access-fixture.invalid";
const audience = "local_access_fixture_audience_0123456789abcdef";
const originPort = await reservePort();
const origin = `https://127.0.0.1:${originPort}`;
const worker = await startLocalWorker({
	adminOrigin: origin,
	publicOrigin: origin,
	protocol: "https",
	access: { mode: "local-jwks", issuer, audience, jwks: { keys: [publicJwk] } },
});
const board = `qa-access-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const adminSecret = worker.adminSecret;

async function token(overrides = {}) {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({ email: "fixture@example.invalid" })
		.setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
		.setIssuer(overrides.issuer || issuer)
		.setAudience(overrides.audience || audience)
		.setIssuedAt(now)
		.setExpirationTime(overrides.expiration || now + 60)
		.sign(privateKey);
}

function request(assertion) {
	return new Promise((resolve, reject) => {
		const req = https.request(
			`${worker.origin}/api/admin/boards/${board}/export`,
			{
				method: "GET",
				rejectUnauthorized: false,
				headers: {
					Origin: origin,
					Authorization: `Bearer ${adminSecret}`,
					"Cf-Access-Jwt-Assertion": assertion,
				},
			},
			(response) => {
				let body = "";
				response.on("data", (chunk) => (body += String(chunk)));
				response.on("end", () =>
					resolve({ status: response.statusCode, body }),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

try {
	const valid = await request(await token());
	assert.equal(valid.status, 200);
	assert.equal(JSON.parse(valid.body).snapshot.boardId, board);
	const wrongAudience = await request(
		await token({ audience: `${audience}-wrong` }),
	);
	assert.equal(wrongAudience.status, 403);
	const expired = await request(
		await token({ expiration: Math.floor(Date.now() / 1000) - 1 }),
	);
	assert.equal(expired.status, 403);
	const missing = await request("");
	assert.equal(missing.status, 403);
	console.log(
		JSON.stringify({
			ok: true,
			board,
			tls: true,
			accessBypass: false,
			localJwks: true,
			validAssertion: valid.status,
			wrongAudience: wrongAudience.status,
			expiredAssertion: expired.status,
			missingAssertion: missing.status,
			productionBypassInvariant: "covered-by-config-and-security-tests",
		}),
	);
} finally {
	await worker.stop();
}
