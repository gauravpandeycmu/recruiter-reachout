import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findRepoRoot } from "./paths.js";
import {
  chromeDefaultExtensionPath,
  findInstalledChromeExtension,
  prepareUnpackedExtension,
  tryPrepareUnpackedExtension,
  waitForExtensionServiceWorker,
} from "./unpackedExtension.js";

export const APOLLO_EXTENSION_ID = "alhgpfoeiimagjlnfekdhkjlkiomcapa";

export interface ApolloSurfacePaths {
  sidePanelPath?: string;
  linkedinSidebarPath?: string;
}

export function findApolloSurfacePaths(resources: string[]): ApolloSurfacePaths {
  const html = resources.filter((resource) => /\.html(?:$|\?)/i.test(resource));
  const sidePanel = html.find((resource) => /(?:^|[_-])side-panel/i.test(resource));
  const linkedinSidebar = html.find((resource) => /linkedin-sidebar/i.test(resource));
  return {
    sidePanelPath: sidePanel ? `/${sidePanel.replace(/^\/+/, "")}` : undefined,
    linkedinSidebarPath: linkedinSidebar ? `/${linkedinSidebar.replace(/^\/+/, "")}` : undefined,
  };
}

export function readApolloSurfacePaths(extensionDir = apolloExtensionCacheDir()): ApolloSurfacePaths {
  try {
    const manifest = JSON.parse(readFileSync(resolve(extensionDir, "manifest.json"), "utf8")) as {
      web_accessible_resources?: Array<{ resources?: string[] }>;
    };
    return findApolloSurfacePaths(
      (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []),
    );
  } catch {
    return {};
  }
}

export function apolloExtensionCacheDir(): string {
  return resolve(findRepoRoot(), "apps/worker/data/apollo-extension");
}

export function prepareApolloExtension(envPath?: string, cacheDir = apolloExtensionCacheDir()): string {
  return prepareUnpackedExtension({
    envPath,
    defaultPath: findInstalledChromeExtension(APOLLO_EXTENSION_ID) ?? chromeDefaultExtensionPath(APOLLO_EXTENSION_ID),
    cacheDir,
    label: "Apollo",
  });
}

export function tryPrepareApolloExtension(envPath?: string): string | undefined {
  return tryPrepareUnpackedExtension({
    envPath,
    defaultPath: findInstalledChromeExtension(APOLLO_EXTENSION_ID) ?? chromeDefaultExtensionPath(APOLLO_EXTENSION_ID),
    cacheDir: apolloExtensionCacheDir(),
    label: "Apollo",
  });
}

export function waitForApolloServiceWorker(
  context: import("playwright").BrowserContext,
  timeoutMs = 30_000,
): Promise<void> {
  return waitForExtensionServiceWorker(context, timeoutMs, APOLLO_EXTENSION_ID);
}
