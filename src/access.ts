/**
 * Cloudflare Access JWT verification.
 *
 * Access already gates the hostname at the edge, so by the time a request
 * reaches this Worker it has normally been authenticated. This module is
 * defense in depth: it re-verifies the assertion at the origin so the PDFs
 * are not readable by anything that manages to reach the Worker directly.
 *
 * Enforcement is on whenever ACCESS_TEAM_DOMAIN and ACCESS_AUD are both set.
 * Leaving them empty serves the app unauthenticated — see the Access section
 * of the README for the activation sequence.
 */

/** Access rotates signing keys; an hour is well inside the rotation window. */
const JWKS_TTL_MS = 60 * 60 * 1000;

interface JwksCache {
  teamDomain: string;
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

// Module scope persists across requests within an isolate, so the JWKS is
// fetched once per isolate per hour rather than once per request.
let jwksCache: JwksCache | null = null;

export interface AccessIdentity {
  email: string;
  sub: string;
}

export type AccessResult =
  | { ok: true; identity: AccessIdentity | null }
  | { ok: false; response: Response };

export async function verifyAccess(
  request: Request,
  teamDomain: string,
  aud: string,
): Promise<AccessResult> {
  if (!teamDomain || !aud) {
    // Not configured — the app is intentionally open. See README.
    return { ok: true, identity: null };
  }

  const token = readToken(request);
  if (!token) {
    return { ok: false, response: deny(401, "Not authenticated.") };
  }

  const payload = await verifyToken(token, teamDomain, aud);
  if (!payload) {
    return { ok: false, response: deny(403, "Not authorized.") };
  }

  return {
    ok: true,
    identity: { email: String(payload.email ?? ""), sub: String(payload.sub ?? "") },
  };
}

/**
 * Access presents the assertion as a header on proxied requests, and as a
 * cookie on browser navigations. Either is acceptable — both are set by
 * Cloudflare, and the signature is what actually establishes trust.
 */
function readToken(request: Request): string | null {
  const header = request.headers.get("cf-access-jwt-assertion");
  if (header) return header;

  const cookies = request.headers.get("cookie");
  if (!cookies) return null;

  for (const part of cookies.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "CF_Authorization" && rest.length > 0) {
      return rest.join("=");
    }
  }

  return null;
}

async function verifyToken(
  token: string,
  teamDomain: string,
  aud: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [rawHeader, rawPayload, rawSignature] = parts;

  let header: { kid?: string; alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(decodeSegment(rawHeader));
    payload = JSON.parse(decodeSegment(rawPayload));
  } catch {
    return null;
  }

  // Pin the algorithm. Accepting whatever the token declares is how "alg: none"
  // and HMAC-with-the-public-key forgeries get in.
  if (header.alg !== "RS256" || !header.kid) return null;

  const key = await lookupKey(header.kid, teamDomain);
  if (!key) return null;

  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(rawSignature);
  } catch {
    return null;
  }

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature as BufferSource,
    signed as BufferSource,
  );
  if (!valid) return null;

  // A valid signature only proves Cloudflare minted the token. These claims
  // prove it was minted for *this* application and is still current.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(aud)) return null;

  if (payload.iss !== `https://${teamDomain}`) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now) return null;

  return payload;
}

async function lookupKey(kid: string, teamDomain: string): Promise<CryptoKey | null> {
  const fresh =
    jwksCache !== null &&
    jwksCache.teamDomain === teamDomain &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;

  if (fresh && jwksCache!.keys.has(kid)) {
    return jwksCache!.keys.get(kid)!;
  }

  // Unknown kid means either a stale cache or a bogus token. Refetch once —
  // this is also what makes key rotation transparent.
  const keys = await fetchJwks(teamDomain);
  if (keys === null) return null;

  jwksCache = { teamDomain, keys, fetchedAt: Date.now() };
  return keys.get(kid) ?? null;
}

async function fetchJwks(teamDomain: string): Promise<Map<string, CryptoKey> | null> {
  let response: Response;
  try {
    response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let body: { keys?: Array<JsonWebKey & { kid?: string }> };
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(body.keys)) return null;

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (!jwk.kid) continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // Skip anything that will not import rather than failing the whole set.
    }
  }

  return keys;
}

function decodeSegment(segment: string): string {
  return new TextDecoder().decode(base64UrlToBytes(segment));
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function deny(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Never let an authorization decision be cached.
      "cache-control": "no-store",
    },
  });
}
