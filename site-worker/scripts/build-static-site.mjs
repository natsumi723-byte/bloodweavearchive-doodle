import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(scriptDir, "..");
const repositoryRoot = path.resolve(siteRoot, "..");
const clientRoot = path.join(repositoryRoot, "client");
const distRoot = path.join(siteRoot, "dist");
const boardId = "bwa-unfinished-archive";
const repository = "natsumi723-byte/bloodweavearchive-doodle";
const releaseSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .trim()
  .toLowerCase();

if (!/^[0-9a-f]{40}$/.test(releaseSha)) {
  throw new Error("Could not resolve the immutable release commit.");
}

process.chdir(clientRoot);
process.env.NODE_ENV = "production";
process.env.WBO_DEFAULT_BOARD = boardId;
process.env.WBO_CLOUDFLARE_AUTHORITATIVE = "true";
process.env.WBO_CLOUDFLARE_BACKEND_URL =
  "wss://api-doodle.bloodweavearchive.com";
process.env.WBO_SOURCE_REPOSITORY = repository;
process.env.WBO_RELEASE_GIT_SHA = releaseSha;
process.env.WBO_CORRESPONDING_SOURCE_URL = `https://github.com/${repository}/tree/${releaseSha}`;

const config = await import("../../client/server/configuration.mjs");
const { BoardTemplate, Template } = await import(
  "../../client/server/http/templating.mjs"
);
const { renderServedBaselineSvg } = await import(
  "../../client/server/persistence/svg_board_store.mjs"
);

const template = new BoardTemplate(
  path.join(clientRoot, "client-data", "board.html"),
  config,
);
const manifestTemplate = new Template(
  path.join(clientRoot, "client-data", "manifest.json"),
  config,
);
const baseline = renderServedBaselineSvg({}, { readonly: false }, 0);

fs.rmSync(distRoot, { recursive: true, force: true });
fs.cpSync(path.join(clientRoot, "client-data"), distRoot, {
  recursive: true,
  filter(source) {
    const basename = path.basename(source);
    return ![
      "board.html",
      "index.html",
      "error.html",
      "rules.html",
      "manifest.json",
      "package.json",
    ].includes(basename);
  },
});

function render(kind, language) {
  const route = kind === "admin" ? "admin" : "boards";
  const host =
    kind === "admin"
      ? "admin-doodle.bloodweavearchive.com"
      : "doodle.bloodweavearchive.com";
  const url = `/${route}/${boardId}?lang=${encodeURIComponent(language)}`;
  const request = {
    url,
    headers: { host, "accept-language": language },
    socket: { encrypted: true },
  };
  return template.renderForRequest(request, {
    boardState: {
      readonly: false,
      canEdit: true,
      canWrite: true,
      canClear: kind === "admin",
      canBan: false,
      canReport: false,
    },
    inlineBoardSvg: baseline,
  });
}

for (const kind of ["public", "admin"]) {
  for (const language of ["en", "zh-CN"]) {
    fs.writeFileSync(
      path.join(distRoot, `${kind}-${language}.html`),
      render(kind, language),
    );
  }
}

for (const language of ["en", "zh-CN"]) {
  const request = {
    url: `/manifest.json?lang=${encodeURIComponent(language)}`,
    headers: {
      host: "doodle.bloodweavearchive.com",
      "accept-language": language,
    },
    socket: { encrypted: true },
  };
  fs.writeFileSync(
    path.join(distRoot, `manifest-${language}.json`),
    manifestTemplate.renderForRequest(request),
  );
}

fs.writeFileSync(
  path.join(distRoot, "release.json"),
  `${JSON.stringify({ releaseSha, correspondingSourceUrl: process.env.WBO_CORRESPONDING_SOURCE_URL }, null, 2)}\n`,
);
console.log(`Built Cloudflare site release ${releaseSha}.`);
