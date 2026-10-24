import test from "node:test";
import assert from "node:assert/strict";
import { productionConfigErrors } from "../src/config.js";

const sha = "4b4d6cfca2122844b77abf5d16b6f460c034c310";
const valid = {
	ENVIRONMENT: "production",
	BACKUP_BOARD_IDS: "bwa-unfinished-archive",
	GOOGLE_DRIVE_FOLDER_ID: "1jz_Li-2T8MivoZ7KECHccNdKYzY9KrQ9",
	ACCESS_TEAM_DOMAIN: "https://bloodweavearchive.cloudflareaccess.com",
	ACCESS_POLICY_AUD: "A".repeat(64),
	SOURCE_REPOSITORY: "natsumi723-byte/bloodweavearchive-doodle",
	RELEASE_GIT_SHA: sha,
	CORRESPONDING_SOURCE_URL: `https://github.com/natsumi723-byte/bloodweavearchive-doodle/tree/${sha}`,
};

test("production bindings validate as one complete release identity", () => {
	assert.deepEqual(productionConfigErrors(valid), []);
	assert.deepEqual(productionConfigErrors({ ENVIRONMENT: "production" }), [
		"invalid_backup_board_ids",
		"invalid_drive_folder_id",
		"invalid_access_team_domain",
		"invalid_access_policy_audience",
		"invalid_corresponding_source",
	]);
	assert.deepEqual(
		productionConfigErrors({
			...valid,
			ALLOW_MISSING_ACCESS_ASSERTION: "true",
			ACCESS_JWKS_JSON: '{"keys":[]}',
		}),
		["production_access_bypass_forbidden", "production_local_jwks_forbidden"],
	);
});
