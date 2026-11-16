import {
  cookieDatabasesForBrowser,
  discoverCredentialsForBrowser,
  profileRootsForBrowser,
  type ChromiumBrowserConfig,
  type ChromiumCredentials,
} from "./chromium-cookies.ts";

export type ChromeCredentials = ChromiumCredentials;

const CHROME_CONFIG: ChromiumBrowserConfig = {
  displayName: "Chrome",
  keychainServiceName: "Chrome Safe Storage",
  secretToolApplication: "chrome",
  macAppSupportPath: ["Google", "Chrome"],
  linuxConfigPath: ["google-chrome"],
  flatpakAppId: "com.google.Chrome",
  windowsUserDataPath: ["Google", "Chrome", "User Data"],
  profileEnvVar: "LUMO_CHROME_PROFILE",
  snapshotPrefix: "pi-lumo-chrome-",
};

export function chromeProfileRoots(
  home?: string,
  xdgConfigHome?: string,
  currentPlatform?: NodeJS.Platform,
  localAppData?: string,
): string[] {
  return profileRootsForBrowser(CHROME_CONFIG, home, xdgConfigHome, currentPlatform, localAppData);
}

export function discoverChromeCredentials(
  databases: string[] = cookieDatabasesForBrowser(profileRootsForBrowser(CHROME_CONFIG)),
): ChromeCredentials | undefined {
  return discoverCredentialsForBrowser(CHROME_CONFIG, databases);
}
