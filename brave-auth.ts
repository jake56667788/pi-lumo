import {
  cookieDatabasesForBrowser,
  discoverCredentialsForBrowser,
  profileRootsForBrowser,
  type ChromiumBrowserConfig,
  type ChromiumCredentials,
  type ChromiumDiscoveryOptions,
} from "./chromium-cookies.ts";

export type BraveCredentials = ChromiumCredentials;

export const BRAVE_CONFIG: ChromiumBrowserConfig = {
  displayName: "Brave",
  keychainServiceName: "Brave Safe Storage",
  secretToolApplication: "brave",
  macAppSupportPath: ["BraveSoftware", "Brave-Browser"],
  linuxConfigPath: ["BraveSoftware", "Brave-Browser"],
  flatpakAppId: "com.brave.Browser",
  snapPaths: [["brave", "current", ".config", "BraveSoftware", "Brave-Browser"]],
  windowsUserDataPath: ["BraveSoftware", "Brave-Browser", "User Data"],
  profileEnvVar: "LUMO_BRAVE_PROFILE",
  snapshotPrefix: "pi-lumo-brave-",
};

export function braveProfileRoots(
  home?: string,
  xdgConfigHome?: string,
  currentPlatform?: NodeJS.Platform,
  localAppData?: string,
): string[] {
  return profileRootsForBrowser(BRAVE_CONFIG, home, xdgConfigHome, currentPlatform, localAppData);
}

export function discoverBraveCredentials(
  databases: string[] = cookieDatabasesForBrowser(profileRootsForBrowser(BRAVE_CONFIG)),
  options?: ChromiumDiscoveryOptions,
): BraveCredentials | undefined {
  return discoverCredentialsForBrowser(BRAVE_CONFIG, databases, options);
}
