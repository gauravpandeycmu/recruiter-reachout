import type { IncomingMessage, ServerResponse } from "node:http";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
}

export type Handler = (context: RequestContext) => Promise<unknown> | unknown;

export interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, accept",
  });
  res.end(JSON.stringify(payload));
}

export function beginNdjson(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, accept",
    "cache-control": "no-cache",
  });
}

export function writeNdjson(res: ServerResponse, payload: unknown): void {
  res.write(`${JSON.stringify(payload)}\n`);
  // Push progress events to the client promptly (avoid TCP buffering on long Gemini waits).
  const flushable = res as ServerResponse & { flush?: () => void };
  flushable.flush?.();
}

export function endNdjson(res: ServerResponse): void {
  res.end();
}

export function sendPixel(res: ServerResponse): void {
  const pixel = Buffer.from(
    "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
    "base64",
  );
  res.writeHead(200, {
    "content-type": "image/gif",
    "cache-control": "no-store",
  });
  res.end(pixel);
}

export function sendRedirect(res: ServerResponse, url: string): void {
  res.writeHead(302, {
    location: url,
    "cache-control": "no-store",
  });
  res.end();
}

export function handleCors(res: ServerResponse): void {
  res.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type, accept",
  });
  res.end();
}
