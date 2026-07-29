/**
 * Cross-checks the R2 bucket against the catalog.
 *
 * Every catalog row names a PDF the app will try to serve. This confirms each
 * one exists in R2 under exactly the expected key and at the expected size,
 * and reports anything in the bucket the catalog does not reference.
 *
 * Worth running after any bulk upload. A key that was silently mangled on the
 * way in (see the `wrangler r2 object put` note in the README) produces a
 * card that 404s on click, and nothing else surfaces that.
 *
 *   npm run verify:r2
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const {
  CLOUDFLARE_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET = "laccd-floorplans",
} = process.env;

for (const [name, value] of Object.entries({
  CLOUDFLARE_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
})) {
  if (!value) {
    console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

/** Page through the whole bucket; ListObjectsV2 caps out at 1000 per call. */
async function listAll() {
  const objects = new Map();
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      objects.set(object.Key, object.Size);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

const rows = JSON.parse(await readFile(join(root, "data", "catalog.json"), "utf8"));
const bucket = await listAll();

console.log(`catalog: ${rows.length} rows    bucket: ${bucket.size} objects\n`);

const missing = [];
const wrongSize = [];
const expected = new Set();

for (const row of rows) {
  // The Worker strips the "pdfs/" prefix before hitting R2.
  const key = row.rel_path.replace(/^pdfs\//, "");
  expected.add(key);

  if (!bucket.has(key)) {
    missing.push(key);
    continue;
  }

  // size_kb is rounded, so allow a kilobyte of slack rather than demanding
  // an exact match against a rounded figure.
  const actualKb = Math.round(bucket.get(key) / 1024);
  if (row.size_kb && Math.abs(actualKb - row.size_kb) > 1) {
    wrongSize.push(`${key} — catalog ${row.size_kb} KB, bucket ${actualKb} KB`);
  }
}

const orphans = [...bucket.keys()].filter((key) => !expected.has(key));

function report(label, items, limit = 15) {
  if (items.length === 0) return;
  console.log(`${label} (${items.length}):`);
  for (const item of items.slice(0, limit)) console.log(`  ${item}`);
  if (items.length > limit) console.log(`  ...and ${items.length - limit} more`);
  console.log();
}

report("MISSING from bucket", missing);
report("SIZE MISMATCH", wrongSize);
report("in bucket but not in catalog", orphans);

// Keys containing "#" are the ones the wrangler CLI silently truncates, so
// call them out explicitly even when they are fine.
const hashKeys = [...expected].filter((key) => key.includes("#"));
if (hashKeys.length > 0) {
  console.log("keys containing '#' (the wrangler truncation case):");
  for (const key of hashKeys) {
    console.log(`  ${bucket.has(key) ? "ok     " : "MISSING"} ${key}`);
  }
  console.log();
}

const failed = missing.length > 0 || wrongSize.length > 0;
console.log(
  failed
    ? `FAILED — ${missing.length} missing, ${wrongSize.length} size mismatches`
    : `all ${rows.length} catalog rows present in R2 at the expected size`,
);
process.exit(failed ? 1 : 0);
