const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=60, must-revalidate",
  vary: "Accept-Language",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function preferredLanguage(url, request) {
  const requested = url.searchParams.get("lang");
  if (requested === "zh-CN" || requested === "en") return requested;
  const accepted = request.headers.get("accept-language") || "";
  return /(^|,)\s*zh(?:-|;|,|$)/i.test(accepted) ? "zh-CN" : "en";
}

function cleanHost(request) {
  return new URL(request.url).hostname.toLowerCase();
}

function boardPath(kind, boardId) {
  return `/${kind}/${encodeURIComponent(boardId)}`;
}

function canonicalBoardRequest(url, kind, boardId) {
  return url.pathname === boardPath(kind, boardId);
}

function isAdminApiRequest(url, host, env) {
  return (
    host === env.ADMIN_HOST && url.pathname.startsWith("/api/admin/boards/")
  );
}

function isPublicCapacityProbe(request, url, host, env) {
  return (
    host === env.PUBLIC_HOST &&
    request.method === "GET" &&
    url.pathname === `/api/boards/${encodeURIComponent(env.BOARD_ID)}/socket` &&
    url.searchParams.size === 1 &&
    url.searchParams.get("capacityProbe") === "1"
  );
}

function isBoardApiRequest(request, url, host, env) {
  return (
    isPublicCapacityProbe(request, url, host, env) ||
    isAdminApiRequest(url, host, env)
  );
}

async function serveBoard(request, env, kind) {
  const url = new URL(request.url);
  const language = preferredLanguage(url, request);
  const assetUrl = new URL(`/${kind}-${language}.html`, url);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  return new Response(response.body, {
    status: response.status,
    headers: { ...HTML_HEADERS, "content-language": language },
  });
}

async function serveManifest(request, env) {
  const url = new URL(request.url);
  const language = preferredLanguage(url, request);
  const assetUrl = new URL(`/manifest-${language}.json`, url);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  return new Response(response.body, {
    status: response.status,
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "content-language": language,
      vary: "Accept-Language",
      "x-content-type-options": "nosniff",
    },
  });
}

function redirect(url, pathname) {
  url.pathname = pathname;
  return Response.redirect(url, 302);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = cleanHost(request);
    const kind = host === env.ADMIN_HOST ? "admin" : "boards";
    const expectedHost = kind === "admin" ? env.ADMIN_HOST : env.PUBLIC_HOST;
    if (host !== expectedHost)
      return new Response("Not found", { status: 404 });

    if (isBoardApiRequest(request, url, host, env)) {
      const response = await env.API.fetch(request);
      if (!isPublicCapacityProbe(request, url, host, env)) return response;
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (url.pathname === "/" || url.pathname === `/${kind}`) {
      return redirect(url, boardPath(kind, env.BOARD_ID));
    }
    if (canonicalBoardRequest(url, kind, env.BOARD_ID)) {
      return serveBoard(request, env, kind === "boards" ? "public" : "admin");
    }
    if (url.pathname === "/manifest.json") return serveManifest(request, env);
    if (
      url.pathname.startsWith("/boards/") ||
      url.pathname.startsWith("/admin/")
    ) {
      return redirect(url, boardPath(kind, env.BOARD_ID));
    }
    if (
      /^\/(?:(?:public|admin)-(?:en|zh-CN)\.html|manifest-(?:en|zh-CN)\.json)$/.test(
        url.pathname,
      )
    ) {
      return new Response("Not found", { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};

export {
  boardPath,
  canonicalBoardRequest,
  isAdminApiRequest,
  isBoardApiRequest,
  isPublicCapacityProbe,
  preferredLanguage,
};
