import { prepareSalesqlExtension } from "./salesqlExtension.js";
import { tryPrepareApolloExtension } from "./apolloExtension.js";

/**
 * Extensions loaded into the LinkedIn Chromium (Setup → Open login, and
 * discovery fallback). SalesQL stays optional via env; Apollo auto-detects
 * the installed Chrome unpacked copy.
 */
export function resolveLinkedInOverlayExtensions(env = process.env): {
  salesqlPath?: string;
  apolloPath?: string;
  paths: string[];
} {
  let salesqlPath: string | undefined;
  if (env.SALESQL_EXTENSION_PATH?.trim()) {
    try {
      salesqlPath = prepareSalesqlExtension(env.SALESQL_EXTENSION_PATH);
    } catch {
      salesqlPath = undefined;
    }
  }
  const apolloPath = tryPrepareApolloExtension(env.APOLLO_EXTENSION_PATH);
  return {
    salesqlPath,
    apolloPath,
    paths: [salesqlPath, apolloPath].filter((path): path is string => Boolean(path)),
  };
}
