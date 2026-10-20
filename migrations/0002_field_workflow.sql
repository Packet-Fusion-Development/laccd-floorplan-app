-- Field workflow: per-project branding, site briefings, and pre-loaded
-- inventory that engineers search, locate, test and tick off.
--
-- Works for any multi-building environment — a university campus, a city's
-- facilities, a company's offices. What a "site" is called and what is being
-- surveyed are project settings, not schema.

-- Per-project settings as JSON, so a new customer's look and wording need no
-- migration. Shape (all optional; the app falls back to generic defaults):
--   {
--     "title": "Zoom Field Survey",
--     "brand_color": "#0B5CFF",
--     "logo_key": "<MEDIA key of the partner/customer logo>",
--     "site_label": { "singular": "Campus", "plural": "Campuses" },
--     "subject": "voice equipment",
--     "categories": [ { "key": "phone", "label": "Phones" }, ... ],
--     "welcome_intro": "...",
--     "support": { "label": "Survey support team", "phone": "+1...", "sms": "+1...", "email": "..." }
--   }
ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';

-- The briefing an engineer reads on arrival at a site.
ALTER TABLE sites ADD COLUMN contact_name TEXT;
ALTER TABLE sites ADD COLUMN contact_phone TEXT;
ALTER TABLE sites ADD COLUMN contact_email TEXT;
ALTER TABLE sites ADD COLUMN parking_info TEXT;
ALTER TABLE sites ADD COLUMN access_hours TEXT;
ALTER TABLE sites ADD COLUMN briefing_notes TEXT;

-- What the customer says is out there: one row per phone, line, or device,
-- imported from a spreadsheet (PBX / Zoom Phone export, asset list, ...).
-- An item is "done" once a non-deleted device row points at it.
CREATE TABLE inventory_items (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id),
  site_id        TEXT NOT NULL REFERENCES sites(id),
  building_id    TEXT REFERENCES buildings(id),
  floor_id       TEXT REFERENCES floors(id),
  category       TEXT NOT NULL,
  name           TEXT,
  extension      TEXT,
  phone_number   TEXT,
  device_model   TEXT,
  mac_address    TEXT,
  listed_location TEXT,
  external_id    TEXT,
  attributes     TEXT NOT NULL DEFAULT '{}',
  import_batch   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at     TEXT,
  CHECK (name IS NOT NULL OR extension IS NOT NULL OR phone_number IS NOT NULL)
);
CREATE INDEX idx_inventory_site ON inventory_items(site_id, category);
CREATE INDEX idx_inventory_project ON inventory_items(project_id);
-- Re-importing the same export updates rows instead of duplicating them.
CREATE UNIQUE INDEX idx_inventory_external ON inventory_items(project_id, external_id) WHERE external_id IS NOT NULL;

-- What the engineer found.
ALTER TABLE devices ADD COLUMN inventory_item_id TEXT REFERENCES inventory_items(id);
ALTER TABLE devices ADD COLUMN test_result TEXT
  CHECK (test_result IN ('working', 'not_working', 'not_tested'));
ALTER TABLE devices ADD COLUMN discrepancy TEXT
  CHECK (discrepancy IN ('wrong_location', 'different_device', 'not_found', 'not_on_list', 'damaged', 'other'));
ALTER TABLE devices ADD COLUMN discrepancy_note TEXT;
CREATE INDEX idx_devices_inventory ON devices(inventory_item_id);
