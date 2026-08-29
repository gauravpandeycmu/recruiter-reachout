import { afterEach, describe, expect, it } from "vitest";
import { seedReady, startHttpApp, type HttpApp } from "./helpers/httpApp.js";

function openIdFromHtml(html: string): string {
  const match = html.match(/\/t\/open\/([^/.]+)\.gif/);
  expect(match?.[1], "preview html should include an open pixel").toBeTruthy();
  return match![1]!;
}

describe("tracking pixel + preview HTTP", () => {
  let app: HttpApp;

  afterEach(async () => {
    if (app) await app.close();
  });

  it("reuses one tracking id across preview polls and attributes open/click to the person", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Pixel Person", "PixelCo", "pixel@pixel.co");

    const first = await app.fetchJson<{ htmlBody: string }>(`/api/candidates/${person.id}/preview`, {
      expectStatus: 200,
    });
    const second = await app.fetchJson<{ htmlBody: string }>(`/api/candidates/${person.id}/preview`, {
      expectStatus: 200,
    });
    const trackingId = openIdFromHtml(first.body.htmlBody);
    expect(openIdFromHtml(second.body.htmlBody)).toBe(trackingId);
    expect(app.store.listTrackingLinks().filter((link) => link.candidateId === person.id)).toHaveLength(1);

    const pixel = await fetch(`${app.baseUrl}/t/open/${trackingId}.gif`);
    expect(pixel.status).toBe(200);
    expect(pixel.headers.get("content-type")).toMatch(/image\/gif/);

    const opens = app.store.listEvents().filter((event) => event.type === "open");
    expect(opens).toHaveLength(1);
    expect(opens[0]?.candidateId).toBe(person.id);
    expect(opens[0]?.trackingId).toBe(trackingId);
    expect(opens[0]?.ip).toBeTruthy();
    expect(opens[0]?.ip).not.toMatch(/127\.0\.0\.1/);

    const click = await fetch(`${app.baseUrl}/t/click/${trackingId}?url=${encodeURIComponent("https://example.com/job")}`, {
      redirect: "manual",
    });
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toBe("https://example.com/job");
    const clicks = app.store.listEvents().filter((event) => event.type === "click");
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.candidateId).toBe(person.id);
    expect(clicks[0]?.targetUrl).toBe("https://example.com/job");
  });

  it("unknown tracking ids still return a pixel and do not invent a candidate event", async () => {
    app = await startHttpApp();
    const pixel = await fetch(`${app.baseUrl}/t/open/does-not-exist.gif`);
    expect(pixel.status).toBe(200);
    expect(app.store.listEvents().filter((event) => event.type === "open")).toHaveLength(0);
  });

  it("sanitizes javascript: click targets the same way the public relay does", async () => {
    app = await startHttpApp();
    const person = seedReady(app, "Safe Click", "SafeCo", "safe@safe.co");
    const preview = await app.fetchJson<{ htmlBody: string }>(`/api/candidates/${person.id}/preview`, {
      expectStatus: 200,
    });
    const trackingId = openIdFromHtml(preview.body.htmlBody);

    const click = await fetch(`${app.baseUrl}/t/click/${trackingId}?url=${encodeURIComponent("javascript:alert(1)")}`, {
      redirect: "manual",
    });
    expect(click.status).toBe(302);
    expect(click.headers.get("location")).toBe("https://mail.google.com");
  });
});
