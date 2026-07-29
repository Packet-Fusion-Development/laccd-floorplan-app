/**
 * Tests for the Cloudflare Access JWT gate (src/access.ts).
 *
 * Auth code that fails open is worse than no auth code, because it looks
 * protected. These mint real RS256 tokens against a throwaway keypair, stub
 * the JWKS endpoint, and assert that every forgery is rejected.
 *
 * No test framework: src/access.ts only uses WebCrypto, fetch, and atob, all
 * of which Node provides, so it imports directly.
 *
 *   npm test
 */
import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// pathToFileURL, not a bare path — Windows drive letters parse as a URL scheme.
const { verifyAccess } = await import(pathToFileURL(join(root, "src", "access.ts")).href);

const TEAM_DOMAIN = "packetfusion.cloudflareaccess.com";
const AUD = "a".repeat(64);
const KID = randomUUID();

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

// Stand in for https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
globalThis.fetch = async () =>
  new Response(JSON.stringify({ keys: [jwk] }), {
    headers: { "content-type": "application/json" },
  });

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function mintToken({ header = {}, payload = {}, signWith = privateKey, tamper = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const fullHeader = { alg: "RS256", kid: KID, typ: "JWT", ...header };
  const fullPayload = {
    aud: [AUD],
    iss: `https://${TEAM_DOMAIN}`,
    exp: now + 3600,
    iat: now,
    email: "rdyla@packetfusion.com",
    sub: "user-123",
    ...payload,
  };

  const encodedHeader = b64url(JSON.stringify(fullHeader));
  const encodedPayload = b64url(JSON.stringify(fullPayload));

  if (signWith === null) return `${encodedHeader}.${encodedPayload}.`;

  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  const signature = b64url(signer.sign(signWith));

  if (tamper) {
    // Same signature, different claims — the classic "edit the payload" attack.
    const swapped = b64url(JSON.stringify({ ...fullPayload, email: "attacker@evil.test" }));
    return `${encodedHeader}.${swapped}.${signature}`;
  }

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

const withToken = (token) =>
  new Request("https://laccd-floorplan-app.packetfusion.com/pdfs/LAVC/x.pdf", {
    headers: token ? { "cf-access-jwt-assertion": token } : {},
  });

let passed = 0;
let failed = 0;

async function check(name, request, expected, { teamDomain = TEAM_DOMAIN, aud = AUD } = {}) {
  const result = await verifyAccess(request, teamDomain, aud);
  const actual = result.ok ? "allow" : `deny:${result.response.status}`;
  if (actual === expected) {
    console.log(`  ok    ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name} — expected ${expected}, got ${actual}`);
    failed++;
  }
}

console.log("Access JWT gate:");

// Unconfigured: the app is intentionally open.
await check("unconfigured serves open", withToken(null), "allow", { teamDomain: "", aud: "" });

// Configured and enforcing.
await check("valid token allowed", withToken(mintToken()), "allow");
await check("missing token rejected", withToken(null), "deny:401");
await check("garbage token rejected", withToken("not-a-jwt"), "deny:403");

await check(
  "expired token rejected",
  withToken(mintToken({ payload: { exp: Math.floor(Date.now() / 1000) - 60 } })),
  "deny:403",
);
await check(
  "not-yet-valid token rejected",
  withToken(mintToken({ payload: { nbf: Math.floor(Date.now() / 1000) + 600 } })),
  "deny:403",
);
await check(
  "token for another application rejected",
  withToken(mintToken({ payload: { aud: ["b".repeat(64)] } })),
  "deny:403",
);
await check(
  "token from another issuer rejected",
  withToken(mintToken({ payload: { iss: "https://evil.cloudflareaccess.com" } })),
  "deny:403",
);
await check("tampered payload rejected", withToken(mintToken({ tamper: true })), "deny:403");
await check(
  "alg:none forgery rejected",
  withToken(mintToken({ header: { alg: "none" }, signWith: null })),
  "deny:403",
);
await check(
  "unknown signing key rejected",
  withToken(
    mintToken({
      signWith: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
    }),
  ),
  "deny:403",
);
await check(
  "unknown kid rejected",
  withToken(mintToken({ header: { kid: randomUUID() } })),
  "deny:403",
);

// The cookie path browsers use on navigations.
await check(
  "valid cookie allowed",
  new Request("https://laccd-floorplan-app.packetfusion.com/pdfs/LAVC/x.pdf", {
    headers: { cookie: `CF_Authorization=${mintToken()}; other=1` },
  }),
  "allow",
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
