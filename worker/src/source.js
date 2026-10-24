export const UPSTREAM_SOURCE_URL = "https://github.com/lovasoa/whitebophir";
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function correspondingSourceUrl(env) {
  const value = String(env.CORRESPONDING_SOURCE_URL || "").trim();
  if (!value) return env.ENVIRONMENT === "production" ? null : UPSTREAM_SOURCE_URL;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    if (env.ENVIRONMENT === "production") {
      const repository = String(env.SOURCE_REPOSITORY || "").trim();
      const releaseSha = String(env.RELEASE_GIT_SHA || "").trim().toLowerCase();
      if (!repository || !COMMIT_SHA.test(releaseSha)) return null;
      const expected = `https://github.com/${repository}/tree/${releaseSha}`;
      if (parsed.href.replace(/\/$/, "") !== expected) return null;
    }
  } catch {
    return null;
  }
  return value;
}
