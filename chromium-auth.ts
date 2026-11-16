import {
  cookieDatabasesForBrowser,
  discoverCredentialsForBrowser,
  profileRootsForBrowser,
  type ChromiumBrowserConfig,
  type ChromiumCredentials,
} from "./chromium-cookies.ts";

export type ChromiumBrowserCredentials = ChromiumCredentials;

const CHROMIUM_CONFIG: ChromiumBrowserConfig = {
  displayName: "Chromium",
  keychainServiceName: "Chromium Safe Storage",
  secretToolApplication: "chromium",
  macAppSupportPath: ["Chromium"],
  linuxConfigPath: ["chromium"],
  flatpakAppId: "org.chromium.Chromium",
  snapPaths: [["chromium", "common", "chromium"]],
  windowsUserDataPath: ["Chromium", "User Data"],
  profileEnvVar: "LUMO_CHROMIUM_PROFILE",
  snapshotPrefix: "pi-lumo-chromium-",
};

export function chromiumProfileRoots(
  home?: string,
  xdgConfigHome?: string,
  currentPlatform?: NodeJS.Platform,
  localAppData?: string,
): string[] {
  return profileRootsForBrowser(CHROMIUM_CONFIG, home, xdgConfigHome, currentPlatform, localAppData);
}

export function discoverChromiumCredentials(
  databases: string[] = cookieDatabasesForBrowser(profileRootsForBrowser(CHROMIUM_CONFIG)),
): ChromiumBrowserCredentials | undefined {
  return discoverCredentialsForBrowser(CHROMIUM_CONFIG, databases);
}
