import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";

const ADMIN_ROUTE = /^\/api\/admin\/boards\/([^/]+)\/socket$/;
const PUBLIC_ROUTE = /^\/api\/boards\/([^/]+)\/socket$/;
const ADMIN_DATA_ROUTE =
	/^\/api\/admin\/boards\/([^/]+)\/(export|restore|purge)$/;

export function parseAllowedOrigins(value) {
	return new Set(
		String(value || "")
			.split(/[\s,]+/)
			.map((origin) => origin.trim().replace(/\/$/, ""))
			.filter(Boolean),
	);
}
export function originAllowed(request, env, admin = false) {
	const origin = request.headers.get("Origin");
	if (!origin) return env.ALLOW_MISSING_ORIGIN === "true";
	const routeOrigins = admin
		? env.ALLOWED_ADMIN_ORIGINS
		: env.ALLOWED_PUBLIC_ORIGINS;
	return parseAllowedOrigins(routeOrigins || env.ALLOWED_ORIGINS).has(
		origin.replace(/\/$/, ""),
	);
}

export function socketRoute(pathname) {
	const admin = pathname.match(ADMIN_ROUTE);
	if (admin) return { board: admin[1], admin: true };
	const publicRoute = pathname.match(PUBLIC_ROUTE);
	if (publicRoute) return { board: publicRoute[1], admin: false };
	return null;
}

export function adminDataRoute(pathname) {
	const match = pathname.match(ADMIN_DATA_ROUTE);
	return match ? { board: match[1], action: match[2] } : null;
}

export function adminCorsHeaders(request) {
	const origin = request.headers.get("Origin")?.replace(/\/$/, "");
	return {
		"Access-Control-Allow-Origin": origin || "null",
		"Access-Control-Allow-Credentials": "true",
		Vary: "Origin",
	};
}

export function withAdminCors(request, response) {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(adminCorsHeaders(request))) {
		headers.set(name, value);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function adminPreflight(request, action) {
	const requestedMethod = request.headers
		.get("Access-Control-Request-Method")
		?.toUpperCase();
	const expectedMethod = action === "export" ? "GET" : "POST";
	const requestedHeaders = String(
		request.headers.get("Access-Control-Request-Headers") || "",
	)
		.split(",")
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
	const allowedHeaders = new Set(["authorization", "content-type"]);
	if (
		requestedMethod !== expectedMethod ||
		requestedHeaders.some((header) => !allowedHeaders.has(header))
	) {
		return withAdminCors(
			request,
			new Response(JSON.stringify({ error: "cors_preflight_rejected" }), {
				status: 403,
				headers: { "Content-Type": "application/json; charset=utf-8" },
			}),
		);
	}
	return new Response(null, {
		status: 204,
		headers: {
			...adminCorsHeaders(request),
			"Access-Control-Allow-Methods": expectedMethod,
			"Access-Control-Allow-Headers": requestedHeaders.join(", "),
			"Access-Control-Max-Age": "600",
		},
	});
}

export function hasAdminProtocol(request) {
	return (request.headers.get("Sec-WebSocket-Protocol") || "")
		.split(",")
		.some((value) => value.trim().startsWith("admin."));
}

export async function hasAccessAssertion(request, env = {}) {
	if (
		env.ENVIRONMENT !== "production" &&
		env.ALLOW_MISSING_ACCESS_ASSERTION === "true"
	)
		return true;
	const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
	const issuer = String(env.ACCESS_TEAM_DOMAIN || "").replace(/\/$/, "");
	const audience = String(env.ACCESS_POLICY_AUD || "").trim();
	if (!token || !issuer.startsWith("https://") || !audience) return false;
	try {
		const jwks =
			env.ENVIRONMENT !== "production" && env.ACCESS_JWKS_JSON
				? createLocalJWKSet(JSON.parse(env.ACCESS_JWKS_JSON))
				: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
		await jwtVerify(token, jwks, {
			issuer,
			audience,
			algorithms: ["RS256"],
		});
		return true;
	} catch {
		return false;
	}
}
