import { describe, expect, it } from "vitest";
import { withKeyLock } from "../src/asyncLock.js";

describe("withKeyLock", () => {
  it("serializes calls with the same key", async () => {
    const order: number[] = [];
    const first = withKeyLock("candidate-1", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);
      return "first";
    });
    const second = withKeyLock("candidate-1", async () => {
      order.push(2);
      return "second";
    });

    const results = await Promise.all([first, second]);
    expect(results).toEqual(["first", "second"]);
    expect(order).toEqual([1, 2]);
  });

  it("does not serialize calls with different keys", async () => {
    const order: string[] = [];
    const a = withKeyLock("candidate-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a");
    });
    const b = withKeyLock("candidate-b", async () => {
      order.push("b");
    });

    await Promise.all([a, b]);
    // b (no delay) finishes before a (delayed) since they're different keys.
    expect(order).toEqual(["b", "a"]);
  });

  it("propagates a rejection to its own caller without blocking the next queued call", async () => {
    const first = withKeyLock("candidate-2", async () => {
      throw new Error("boom");
    });
    await expect(first).rejects.toThrow("boom");

    const second = withKeyLock("candidate-2", async () => "recovered");
    await expect(second).resolves.toBe("recovered");
  });
});
