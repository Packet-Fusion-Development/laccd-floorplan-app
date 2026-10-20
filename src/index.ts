/**
 * PF Site Survey — edge entrypoint.
 *
 * Three classes of request:
 *   /api/*   → survey API backed by D1 (see ./api.ts)
 *   /pdfs/*  → streamed out of R2 (719 source drawings, ~380 MB)
 *   /        → redirect to /survey
 *   /results/<project> → the results page (static, reads the project from the URL)
 *   anything → the static bundle in ./public (survey app, LACCD library at /laccd, thumbnails)
 *
 * The PDFs deliberately sit behind the Worker rather than on a public R2
 * domain: it keeps a single hostname for Cloudflare Access to gate, and it
 * means the bucket itself never has to be world-readable.
 */

import { verifyAccess } from "./access";
import { handleApi, resolveViewer } from "./api";

export interface Env {
  /** Static assets: frontend shell, catalog.json, and floor-plan thumbnails. */
  ASSETS: Fetcher;
  /** LACCD source PDFs, keyed as "<CAMPUS_CODE>/<filename>.pdf". Other projects' plans are in MEDIA. */
  PDFS: R2Bucket;
  /** Multi-project survey database — see migrations/0001_multi_project_schema.sql. */
  DB: D1Database;
  /** Survey photos, keyed "<project_code>/surveys/<survey_id>/photos/<photo_id>.<ext>". */
  MEDIA: R2Bucket;
  /** Access team domain, e.g. "packetfusion.cloudflareaccess.com". Empty = no enforcement. */
  ACCESS_TEAM_DOMAIN: string;
  /** Access application AUD tag. Empty = no enforcement. */
  ACCESS_AUD: string;
  /** Comma-separated emails allowed to change project setup (branding, briefings, imports). */
  ADMIN_EMAILS?: string;
  /** Comma-separated email domains treated as Packet Fusion staff. Default "packetfusion.com". */
  INTERNAL_DOMAINS?: string;
}

/** Requests under this prefix are served from R2 rather than from static assets. */
const PDF_PREFIX = "/pdfs/";

/** Survey API; must also be listed in assets.run_worker_first in wrangler.jsonc. */
const API_PREFIX = "/api/";

/** A project's results page, e.g. /results/laccd-dts. */
const RESULTS_PAGE = /^\/results\/[a-z0-9_-]+\/?$/i;

/**
 * Drawings are revised by re-export, not in place, so a long shared-cache TTL
 * is safe. The shorter browser TTL keeps a stale copy from pinning a user to
 * a superseded revision for a full day.
 */
const PDF_CACHE_CONTROL_PUBLIC = "public, max-age=3600, s-maxage=86400";

/**
 * Once Access is enforcing, the drawings are authenticated content. "private"
 * keeps intermediary caches — corporate proxies in particular — from holding a
 * copy they would hand to someone who never passed the Access check. It also
 * disables our own edge cache, since the Cache API honours it; that costs an
 * R2 read per request, which is the right trade for not leaking drawings.
 */
const PDF_CACHE_CONTROL_PRIVATE = "private, max-age=3600";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // The site root is the survey app. (There is no public/index.html, so
    // static assets fall through to the Worker for "/".)
    if (url.pathname === "/") {
      return Response.redirect(new URL("/survey", url).toString(), 302);
    }

    // /results/<project> is one static page that reads the code from the URL.
    if (RESULTS_PAGE.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL("/results/", url), request));
    }

    if (url.pathname.startsWith(API_PREFIX)) {
      // Survey data is the most sensitive thing served here, so it gets the
      // same origin-side re-check as the drawings.
      const access = await verifyAccess(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      if (!access.ok) return access.response;
      return handleApi(request, env, identityOf(request, env, access.identity?.email));
    }

    if (url.pathname.startsWith(PDF_PREFIX)) {
      // Access gates the hostname at the edge; this re-checks the assertion so
      // the drawings stay protected even if something reaches the Worker
      // directly. Static assets are not re-checked here — see README.
      const access = await verifyAccess(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      if (!access.ok) return access.response;
      // Drawings are for Packet Fusion staff; customer accounts see results only.
      const viewer = await resolveViewer(env, identityOf(request, env, access.identity?.email));
      if (!viewer.internal) return new Response("Not available for this account.", { status: 403 });

      const gated = Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
      return servePdf(request, env, ctx, url, gated);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * The signed-in email. Only when Access is switched off (local dev) may a
 * request pose as someone via x-dev-user, so the customer view and its limits
 * can be tested on localhost. With Access configured the header is ignored.
 */
function identityOf(request: Request, env: Env, accessEmail: string | undefined): string | null {
  if (accessEmail) return accessEmail;
  const accessOff = !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD;
  return (accessOff && request.headers.get("x-dev-user")) || null;
}

async function servePdf(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  gated: boolean,
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
  // The cache key below is a bare GET, so it carries no validators. Serving a
  // revalidation from it would return a full 200 body and never a 304, so
  // conditional requests bypass the cache and let R2's `onlyIf` answer them.
  const isConditional =
    request.headers.has("if-none-match") || request.headers.has("if-modified-since");

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });

  if (isGet && !isRangeRequest && !isConditional && !gated) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  // LACCD's drawings live in their own bucket (keys like "ELAC/…"). Drawings
  // for every other project live with that project's media, under
  // "<project_code>/plans/…", so a new customer never writes into LACCD's bucket.
  const bucket = key.includes("/plans/") ? env.MEDIA : env.PDFS;
  const object = await bucket.get(key, {
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
  headers.set("cache-control", gated ? PDF_CACHE_CONTROL_PRIVATE : PDF_CACHE_CONTROL_PUBLIC);
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
  if (!gated) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }
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
