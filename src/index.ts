/**
 * LACCD Floorplan Catalog — edge entrypoint.
 *
 * Two classes of request:
 *   /pdfs/*  → streamed out of R2 (719 source drawings, ~380 MB)
 *   anything → the static bundle in ./public (shell, catalog.json, thumbnails)
 *
 * The PDFs deliberately sit behind the Worker rather than on a public R2
 * domain: it keeps a single hostname for Cloudflare Access to gate, and it
 * means the bucket itself never has to be world-readable.
 */

export interface Env {
  /** Static assets: frontend shell, catalog.json, and floor-plan thumbnails. */
  ASSETS: Fetcher;
  /** Source PDFs, keyed as "<CAMPUS_CODE>/<filename>.pdf" (e.g. "ELAC/ELAC A5 Floor Plan.pdf"). */
  PDFS: R2Bucket;
}

/** Requests under this prefix are served from R2 rather than from static assets. */
const PDF_PREFIX = "/pdfs/";

/**
 * Drawings are revised by re-export, not in place, so a long shared-cache TTL
 * is safe. The shorter browser TTL keeps a stale copy from pinning a user to
 * a superseded revision for a full day.
 */
const PDF_CACHE_CONTROL = "public, max-age=3600, s-maxage=86400";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith(PDF_PREFIX)) {
      return servePdf(request, env, ctx, url);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function servePdf(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }

  const key = decodeKey(url.pathname.slice(PDF_PREFIX.length));
  if (key === null) {
    return new Response("Not Found", { status: 404 });
  }

  const isGet = request.method === "GET";
  // Browsers issue range requests to stream large PDFs progressively. A 206
  // must never be stored under — or served from — the whole-object cache key.
  const isRangeRequest = request.headers.has("range");
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });

  if (isGet && !isRangeRequest) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const object = await env.PDFS.get(key, {
    range: request.headers,
    onlyIf: request.headers,
  });

  if (object === null) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", PDF_CACHE_CONTROL);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/pdf");
  }
  // Open in the browser's PDF viewer instead of forcing a download.
  headers.set("content-disposition", contentDisposition(key));

  // R2 hands back a bodyless R2Object when the `onlyIf` preconditions fail.
  if (!("body" in object)) {
    const isConditionalRead =
      request.headers.has("if-none-match") ||
      request.headers.has("if-modified-since");
    return new Response(null, {
      status: isConditionalRead ? 304 : 412,
      headers,
    });
  }

  if (isRangeRequest && object.range) {
    const { start, end } = resolveRange(object.range, object.size);
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
    headers.set("content-length", String(end - start + 1));
    return new Response(isGet ? object.body : null, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));

  if (!isGet) {
    return new Response(null, { status: 200, headers });
  }

  const response = new Response(object.body, { status: 200, headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/**
 * Turn the URL path tail into an R2 key, rejecting anything that could escape
 * the bucket namespace. Filenames legitimately contain spaces, "&", and "#",
 * so the path arrives percent-encoded.
 */
function decodeKey(rawPath: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(rawPath);
  } catch {
    return null; // malformed percent-encoding
  }

  if (!key || key.startsWith("/") || key.split("/").includes("..")) {
    return null;
  }

  return key;
}

/** Normalise R2's three range shapes into absolute start/end byte offsets. */
function resolveRange(range: R2Range, size: number): { start: number; end: number } {
  if ("suffix" in range && range.suffix !== undefined) {
    return { start: Math.max(0, size - range.suffix), end: size - 1 };
  }

  const { offset, length } = range as { offset?: number; length?: number };
  const start = offset ?? 0;
  const span = length ?? size - start;
  return { start, end: Math.min(size - 1, start + span - 1) };
}

function contentDisposition(key: string): string {
  const filename = key.slice(key.lastIndexOf("/") + 1);
  // RFC 5987 encoding — plain `filename="..."` cannot carry these characters.
  return `inline; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
