import { resolve } from "node:path";
import { findRepoRoot } from "./paths.js";
import { prepareUnpackedExtension, tryPrepareUnpackedExtension, waitForExtensionServiceWorker } from "./unpackedExtension.js";

export const APOLLO_EXTENSION_ID = "alhgpfoeiimagjlnfekdhkjlkiomcapa";

const DEFAULT_EXTENSION_PATH =
  `/Users/gaurav/Library/Application Support/Google/Chrome/Default/Extensions/${APOLLO_EXTENSION_ID}/16.4.0_0`;

export function apolloExtensionCacheDir(): string {
  return resolve(findRepoRoot(), "apps/worker/data/apollo-extension");
}

export function prepareApolloExtension(envPath?: string, cacheDir = apolloExtensionCacheDir()): string {
  return prepareUnpackedExtension({
    envPath,
    defaultPath: DEFAULT_EXTENSION_PATH,
    cacheDir,
    label: "Apollo",
  });
}

export function tryPrepareApolloExtension(envPath?: string): string | undefined {
  return tryPrepareUnpackedExtension({
    envPath,
    defaultPath: DEFAULT_EXTENSION_PATH,
    cacheDir: apolloExtensionCacheDir(),
    label: "Apollo",
  });
}

export const waitForApolloServiceWorker = waitForExtensionServiceWorker;
