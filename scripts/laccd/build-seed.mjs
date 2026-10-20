/**
 * Builds data/laccd/seed/laccd.sql from data/laccd/catalog.json.
 *
 * LACCD is the first project in the multi-project schema
 * (migrations/0001_multi_project_schema.sql). This turns the flat catalog —
 * one row per drawing sheet — into customer → project → site → building →
 * floor → floor_plan rows, plus one room row per distinct room number.
 *
 * Ids are derived from each row's natural key, so re-running the seed after a
 * catalog edit updates nothing and duplicates nothing: every insert is
 * ON CONFLICT DO NOTHING against a stable id. Apply with:
 *
 *   npm run laccd:seed:local       (local D1)
 *   npm run laccd:seed:remote      (the deployed D1 — real data)
 *
 * Room names are not paired with room numbers in the source export (287 of
 * the 335 sheets that carry room data have lists of different lengths), so
 * they are kept as search text on the floor plan rather than guessed onto rooms.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE = join(root, "data", "laccd", "catalog.json");
const OUTPUT = join(root, "data", "laccd", "seed", "laccd.sql");

const CUSTOMER = { key: "customer:laccd", name: "Los Angeles Community College District" };
const PROJECT = { key: "project:laccd-dts", code: "laccd-dts", name: "LACCD District Technology Survey" };

// Field-app settings for this project (see migrations/0002_field_workflow.sql).
// Support numbers and the partner logo are left for an admin to set in Setup.
// Names follow the field-survey mockups: "label" is the briefing button,
// "title" names the items on the list and form screens ("Site A — Phones").
const PROJECT_SETTINGS = {
  site_label: { singular: "Campus", plural: "Campuses" },
  subject: "voice equipment",
  categories: [
    {
      key: "phone", label: "User List", title: "Phones",
      fields: [{ key: "cable_drop_status", label: "Cable drop status", type: "select", options: ["Present", "Not Present"], required: false }],
    },
    { key: "analog", label: "Analog Stations", title: "Analog Stations", fields: [] },
    { key: "pots", label: "POTS Survey", title: "POTS Lines", fields: [] },
    { key: "emergency", label: "Emergency Phones", title: "Emergency Phones", fields: [] },
  ],
  support: { label: "Packet Fusion Support", phone: null, sms: null, email: null },
};

/** Name-based UUID (v5 layout over SHA-1), stable for a given natural key. */
function stableId(key) {
  const h = createHash("sha1").update(`pf-site-survey:${key}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sql(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insert(table, row) {
  const cols = Object.keys(row);
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(c => sql(row[c])).join(", ")}) ON CONFLICT(id) DO NOTHING;`;
}

const rows = JSON.parse(await readFile(SOURCE, "utf8"));

const out = [];
const seen = new Set();
const once = (id, line) => {
  if (seen.has(id)) return;
  seen.add(id);
  out.push(line);
};

const customerId = stableId(CUSTOMER.key);
const projectId = stableId(PROJECT.key);
once(customerId, insert("customers", { id: customerId, name: CUSTOMER.name }));
once(projectId, insert("projects", {
  id: projectId, customer_id: customerId, code: PROJECT.code, name: PROJECT.name,
}));
// Only fills settings that were never set, so re-seeding keeps an admin's edits.
out.push(`UPDATE projects SET settings = ${sql(JSON.stringify(PROJECT_SETTINGS))} WHERE id = ${sql(projectId)} AND settings = '{}';`);

const roomNumbersByFloor = new Map();

for (const r of rows) {
  const siteKey = `${PROJECT.key}|${r.campus_code}`;
  const buildingKey = `${siteKey}|${r.building}`;
  const floorKey = `${buildingKey}|${r.floor}`;
  const siteId = stableId(siteKey);
  const buildingId = stableId(buildingKey);
  const floorId = stableId(floorKey);

  once(siteId, insert("sites", { id: siteId, project_id: projectId, code: r.campus_code, name: r.campus_name }));
  once(buildingId, insert("buildings", { id: buildingId, site_id: siteId, name: r.building }));
  once(floorId, insert("floors", { id: floorId, building_id: buildingId, name: r.floor }));

  const planId = stableId(`${PROJECT.key}|plan|${r.rel_path}`);
  once(planId, insert("floor_plans", {
    id: planId,
    floor_id: floorId,
    // Served at /pdfs/<key>; the bucket stores keys without the "pdfs/" prefix.
    r2_key: r.rel_path.replace(/^pdfs\//, ""),
    thumb_path: r.thumb_path,
    filename: r.filename,
    size_kb: r.size_kb,
    is_supporting_document: Boolean(r.is_supporting_document),
    wing_section: r.wing_section,
    draft_date: r.draft_date,
    revision_number: r.revision_number,
    drawing_project_number: r.project_number,
    sheet_numbers: JSON.stringify(r.sheet_numbers ?? []),
    room_names_raw: JSON.stringify(r.room_names ?? []),
    additional_notes: r.additional_notes,
  }));

  // A floor split across sheets repeats room numbers; rooms are per floor.
  const numbers = roomNumbersByFloor.get(floorId) ?? new Set();
  for (const n of r.room_numbers ?? []) {
    const number = String(n).trim();
    if (number) numbers.add(number);
  }
  roomNumbersByFloor.set(floorId, numbers);
}

let roomCount = 0;
for (const [floorId, numbers] of roomNumbersByFloor) {
  for (const number of numbers) {
    const roomId = stableId(`room|${floorId}|${number}`);
    once(roomId, insert("rooms", { id: roomId, floor_id: floorId, number, created_by: "seed:catalog" }));
    roomCount++;
  }
}

await mkdir(dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `-- Generated by scripts/laccd/build-seed.mjs from data/laccd/catalog.json. Do not edit.\n${out.join("\n")}\n`);

console.log(`seed written: ${OUTPUT}`);
console.log(`  ${rows.length} floor plans, ${roomCount} rooms, ${out.length} statements`);
