/**
 * Seeds / re-syncs the R2 bucket from the local ./pdfs directory.
 *
 * The PDFs are not in git (~380 MB), so this is how a fresh bucket gets filled
 * and how a revised drawing gets pushed. Objects are keyed exactly as the
 * catalog's rel_path minus the "pdfs/" prefix, which is what the Worker looks
 * up: "ELAC/ELAC A5 Floor Plan.pdf".
 *
 * Safe to re-run — by default it skips objects already present at the same
 * size. Pass --force to overwrite regardless.
 *
 *   npm run laccd:upload-pdfs
 *   npm run laccd:upload-pdfs -- --force
 *   npm run laccd:upload-pdfs -- --dry-run
 *
 * Credentials come from .env (see .env.example). Create an R2 API token with
 * Object Read & Write on the laccd-floorplans bucket.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PDF_DIR = join(root, "pdfs");
const CONCURRENCY = 8;

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const dryRun = args.has("--dry-run");

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

/** Recursively collect every PDF under ./pdfs as a bucket-relative key. */
async function collect(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collect(path)));
    } else if (entry.name.toLowerCase().endsWith(".pdf")) {
      // R2 keys always use forward slashes, regardless of host platform.
      found.push({ path, key: relative(PDF_DIR, path).split(sep).join("/") });
    }
  }
  return found;
}

async function alreadyUploaded(file) {
  try {
    const head = await client.send(
      new HeadObjectCommand({ Bucket: R2_BUCKET, Key: file.key }),
    );
    const local = await stat(file.path);
    return head.ContentLength === local.size;
  } catch {
    return false; // absent, or not readable — treat as needing upload
  }
}

const files = (await collect(PDF_DIR)).sort((a, b) => a.key.localeCompare(b.key));
const totalBytes = (
  await Promise.all(files.map(async (f) => (await stat(f.path)).size))
).reduce((sum, size) => sum + size, 0);

console.log(
  `${files.length} PDFs (${(totalBytes / 1024 ** 2).toFixed(0)} MB) → r2://${R2_BUCKET}` +
    `${dryRun ? "  [dry run]" : ""}${force ? "  [force]" : ""}`,
);

const counts = { uploaded: 0, skipped: 0, failed: 0 };
let cursor = 0;

async function worker() {
  while (cursor < files.length) {
    const file = files[cursor++];

    if (!force && (await alreadyUploaded(file))) {
      counts.skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  would upload  ${file.key}`);
      counts.uploaded++;
      continue;
    }

    try {
      await client.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: file.key,
          Body: await readFile(file.path),
          ContentType: "application/pdf",
        }),
      );
      counts.uploaded++;
    } catch (error) {
      counts.failed++;
      console.error(`  FAILED  ${file.key}: ${error.message}`);
    }

    const done = counts.uploaded + counts.skipped + counts.failed;
    if (done % 25 === 0) console.log(`  ${done}/${files.length}`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(
  `done — ${counts.uploaded} uploaded, ${counts.skipped} already current, ${counts.failed} failed`,
);
process.exit(counts.failed > 0 ? 1 : 0);
