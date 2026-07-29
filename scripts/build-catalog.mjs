/**
 * Builds public/catalog.json from data/catalog.json.
 *
 * data/catalog.json is the tracked source of truth (pretty-printed, reviewable
 * in diffs). The served copy is minified and generated at build time, so the
 * repo never carries two copies of the same 680 KB.
 *
 * Also acts as a pre-deploy tripwire: a row whose thumbnail is missing, or
 * whose PDF is absent from ./pdfs, would ship as a broken card.
 */
import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "data", "catalog.json");
const OUTPUT = join(root, "public", "catalog.json");

const REQUIRED_FIELDS = [
  "campus_code",
  "campus_name",
  "building",
  "floor",
  "filename",
  "rel_path",
  "thumb_path",
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const rows = JSON.parse(await readFile(SOURCE, "utf8"));

if (!Array.isArray(rows) || rows.length === 0) {
  throw new Error(`${SOURCE} did not contain a non-empty array of rows`);
}

const errors = [];
const warnings = [];
const seen = new Set();

for (const [i, row] of rows.entries()) {
  const label = row.rel_path ?? `row ${i}`;

  for (const field of REQUIRED_FIELDS) {
    if (!row[field]) errors.push(`${label}: missing required field "${field}"`);
  }

  if (row.rel_path) {
    if (seen.has(row.rel_path)) errors.push(`${label}: duplicate rel_path`);
    seen.add(row.rel_path);

    if (!row.rel_path.startsWith("pdfs/")) {
      errors.push(`${label}: rel_path must start with "pdfs/"`);
    }
  }

  // Thumbnails ship as static assets, so a missing one is a hard failure.
  if (row.thumb_path && !(await exists(join(root, "public", row.thumb_path)))) {
    errors.push(`${label}: thumbnail not found at public/${row.thumb_path}`);
  }

  // PDFs live in R2. A local miss only means this checkout cannot re-seed the
  // bucket — it does not necessarily mean the deployed object is absent.
  if (row.rel_path && !(await exists(join(root, row.rel_path)))) {
    warnings.push(`${label}: no local copy (cannot be re-uploaded from here)`);
  }
}

if (errors.length > 0) {
  console.error(`catalog build failed — ${errors.length} error(s):`);
  for (const error of errors.slice(0, 20)) console.error(`  ${error}`);
  if (errors.length > 20) console.error(`  ...and ${errors.length - 20} more`);
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn(`${warnings.length} row(s) have no local PDF:`);
  for (const warning of warnings.slice(0, 5)) console.warn(`  ${warning}`);
  if (warnings.length > 5) console.warn(`  ...and ${warnings.length - 5} more`);
}

await writeFile(OUTPUT, JSON.stringify(rows), "utf8");

const campuses = new Set(rows.map((row) => row.campus_code)).size;
console.log(
  `catalog: ${rows.length} sheets across ${campuses} campuses → public/catalog.json`,
);
