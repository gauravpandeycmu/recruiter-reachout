import { describe, expect, it, vi } from "vitest";

vi.mock("../src/salesqlExtension.js", () => ({
  prepareSalesqlExtension: vi.fn((path: string) => `/prepared/salesql${path.startsWith("/") ? path : `/${path}`}`),
}));

vi.mock("../src/apolloExtension.js", () => ({
  tryPrepareApolloExtension: vi.fn((path?: string) => (path ? `/prepared/apollo${path.startsWith("/") ? path : `/${path}`}` : undefined)),
}));

import { prepareSalesqlExtension } from "../src/salesqlExtension.js";
import { tryPrepareApolloExtension } from "../src/apolloExtension.js";
import { resolveLinkedInOverlayExtensions } from "../src/linkedinOverlayExtensions.js";

describe("resolveLinkedInOverlayExtensions", () => {
  it("returns empty paths when neither extension is configured", () => {
    vi.mocked(tryPrepareApolloExtension).mockReturnValueOnce(undefined);
    expect(resolveLinkedInOverlayExtensions({})).toEqual({
      salesqlPath: undefined,
      apolloPath: undefined,
      paths: [],
    });
  });

  it("includes prepared SalesQL and Apollo paths when configured", () => {
    vi.mocked(tryPrepareApolloExtension).mockReturnValueOnce("/prepared/apollo/from-env");
    const result = resolveLinkedInOverlayExtensions({
      SALESQL_EXTENSION_PATH: "/raw/salesql",
      APOLLO_EXTENSION_PATH: "/raw/apollo",
    });
    expect(prepareSalesqlExtension).toHaveBeenCalledWith("/raw/salesql");
    expect(result.paths).toEqual(["/prepared/salesql/raw/salesql", "/prepared/apollo/from-env"]);
    expect(result.salesqlPath).toBe("/prepared/salesql/raw/salesql");
  });

  it("drops SalesQL when prepare throws but keeps Apollo", () => {
    vi.mocked(prepareSalesqlExtension).mockImplementationOnce(() => {
      throw new Error("bad zip");
    });
    vi.mocked(tryPrepareApolloExtension).mockReturnValueOnce("/prepared/apollo/ok");
    const result = resolveLinkedInOverlayExtensions({
      SALESQL_EXTENSION_PATH: "/broken",
    });
    expect(result.salesqlPath).toBeUndefined();
    expect(result.apolloPath).toBe("/prepared/apollo/ok");
    expect(result.paths).toEqual(["/prepared/apollo/ok"]);
  });
});
