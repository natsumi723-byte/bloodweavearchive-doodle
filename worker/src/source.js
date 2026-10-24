export const UPSTREAM_SOURCE_URL = "https://github.com/lovasoa/whitebophir";

export function correspondingSourceUrl(env) {
  const value = String(env.CORRESPONDING_SOURCE_URL || "").trim();
  if (!value) return env.ENVIRONMENT === "production" ? null : UPSTREAM_SOURCE_URL;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  if (env.ENVIRONMENT === "production" && value === UPSTREAM_SOURCE_URL) return null;
  return value;
}
