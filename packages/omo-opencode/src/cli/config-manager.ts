export { addPluginToOpenCodeConfig } from "./config-manager/add-plugin-to-opencode-config";
export type { BackupResult } from "./config-manager/backup-config";
export { backupConfigFile } from "./config-manager/backup-config";
export type { BunInstallResult } from "./config-manager/bun-install";
export { runBunInstall, runBunInstallWithDetails } from "./config-manager/bun-install";
export type { ConfigContext } from "./config-manager/config-context";
export {
	getConfigContext,
	initConfigContext,
	resetConfigContext,
} from "./config-manager/config-context";
export { detectCurrentConfig } from "./config-manager/detect-current-config";
export { generateOmoConfig } from "./config-manager/generate-omo-config";
export { fetchNpmDistTags } from "./config-manager/npm-dist-tags";
export { getOpenCodeVersion, isOpenCodeInstalled } from "./config-manager/opencode-binary";
export { getPluginNameWithVersion } from "./config-manager/plugin-name-with-version";
export type { VersionCompatibility } from "./config-manager/version-compatibility";
export {
	checkVersionCompatibility,
	extractVersionFromPluginEntry,
} from "./config-manager/version-compatibility";
export { writeOmoConfig } from "./config-manager/write-omo-config";
