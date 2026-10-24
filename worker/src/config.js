import { normalizeBoardId } from "./protocol.js";
import { correspondingSourceUrl } from "./source.js";

const DRIVE_FOLDER_ID = /^[A-Za-z0-9_-]{10,128}$/;
const ACCESS_AUDIENCE = /^[A-Za-z0-9_-]{32,128}$/;

export function productionConfigErrors(env) {
	const errors = [];
	if (env.ALLOW_MISSING_ACCESS_ASSERTION === "true") {
		errors.push("production_access_bypass_forbidden");
	}
	if (env.ACCESS_JWKS_JSON) {
		errors.push("production_local_jwks_forbidden");
	}
	const boardIds = String(env.BACKUP_BOARD_IDS || "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (
		!boardIds.length ||
		boardIds.some((value) => normalizeBoardId(value) !== value)
	) {
		errors.push("invalid_backup_board_ids");
	}
	if (!DRIVE_FOLDER_ID.test(String(env.GOOGLE_DRIVE_FOLDER_ID || ""))) {
		errors.push("invalid_drive_folder_id");
	}
	try {
		const team = new URL(String(env.ACCESS_TEAM_DOMAIN || ""));
		if (
			team.protocol !== "https:" ||
			team.pathname !== "/" ||
			team.search ||
			team.hash
		) {
			errors.push("invalid_access_team_domain");
		}
	} catch {
		errors.push("invalid_access_team_domain");
	}
	if (!ACCESS_AUDIENCE.test(String(env.ACCESS_POLICY_AUD || ""))) {
		errors.push("invalid_access_policy_audience");
	}
	if (!correspondingSourceUrl(env)) errors.push("invalid_corresponding_source");
	return [...new Set(errors)];
}

export function requireProductionConfig(env) {
	const errors = productionConfigErrors(env);
	if (errors.length)
		throw new Error(`production_config_invalid:${errors.join(",")}`);
}
