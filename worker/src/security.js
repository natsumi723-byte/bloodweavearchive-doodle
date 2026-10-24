const ADMIN_ROUTE = /^\/api\/admin\/boards\/([^/]+)\/socket$/;
const PUBLIC_ROUTE = /^\/api\/boards\/([^/]+)\/socket$/;
const ADMIN_DATA_ROUTE = /^\/api\/admin\/boards\/([^/]+)\/(export|restore|purge)$/;

export function parseAllowedOrigins(value) {
  return new Set(String(value || "")
    .split(/[\s,]+/)
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean));
}

export function originAllowed(request, env, admin = false) {
  const origin = request.headers.get("Origin");
  if (!origin) return env.ALLOW_MISSING_ORIGIN === "true";
  const routeOrigins = admin ? env.ALLOWED_ADMIN_ORIGINS : env.ALLOWED_PUBLIC_ORIGINS;
  return parseAllowedOrigins(routeOrigins || env.ALLOWED_ORIGINS)
    .has(origin.replace(/\/$/, ""));
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

export function hasAdminProtocol(request) {
  return (request.headers.get("Sec-WebSocket-Protocol") || "")
    .split(",")
    .some((value) => value.trim().startsWith("admin."));
}

export function hasAccessAssertion(request, env = {}) {
  return Boolean(request.headers.get("Cf-Access-Jwt-Assertion")?.trim()) ||
    env.ALLOW_MISSING_ACCESS_ASSERTION === "true";
}
