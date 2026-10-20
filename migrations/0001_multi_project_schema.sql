-- Multi-project schema for PF Site Survey.
--
-- Hierarchy:
--   customer → project → site → building → floor → floor_plan (sheet)
--                                               → room
--   project → survey → device → photo
--
-- Every id is a TEXT UUID so field devices can create rows while offline and
-- sync them later without colliding. Rows that sync from the field carry
-- updated_at (last-write-wins) and deleted_at (soft delete, so a deletion
-- made offline still propagates instead of the row silently reappearing).
--
-- Timestamps are ISO-8601 UTC strings, the form SQLite's date functions read.
-- D1 enforces foreign keys on every connection, so no PRAGMA is needed.

-- A Packet Fusion customer. crm_account_id links to Dynamics 365 / CloudConnect.
CREATE TABLE customers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  crm_account_id  TEXT UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One engagement for a customer, e.g. "LACCD District Technology Survey".
-- code is the short slug used in URLs and as the R2 key prefix for new uploads.
CREATE TABLE projects (
  id                       TEXT PRIMARY KEY,
  customer_id              TEXT NOT NULL REFERENCES customers(id),
  code                     TEXT NOT NULL UNIQUE,
  name                     TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('planning', 'active', 'complete', 'archived')),
  cloudconnect_project_id  TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_projects_customer ON projects(customer_id);

-- A physical location within a project: a campus, office, or branch.
CREATE TABLE sites (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  address     TEXT,
  latitude    REAL,
  longitude   REAL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, code)
);

CREATE TABLE buildings (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL REFERENCES sites(id),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (site_id, name)
);

CREATE TABLE floors (
  id           TEXT PRIMARY KEY,
  building_id  TEXT NOT NULL REFERENCES buildings(id),
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (building_id, name)
);

-- One drawing sheet. A floor can span several sheets ("Page One", "Page Two"),
-- and supporting documents (cover pages, general notes) hang off a floor too.
-- r2_key is relative to the PDFS bucket and served at /pdfs/<r2_key>.
-- room_names_raw keeps the sheet's room-name list as imported: it does not
-- pair 1:1 with room numbers, so it is search text, not room rows.
CREATE TABLE floor_plans (
  id                      TEXT PRIMARY KEY,
  floor_id                TEXT NOT NULL REFERENCES floors(id),
  r2_key                  TEXT NOT NULL UNIQUE,
  thumb_path              TEXT,
  filename                TEXT NOT NULL,
  size_kb                 INTEGER,
  is_supporting_document  INTEGER NOT NULL DEFAULT 0,
  wing_section            TEXT,
  draft_date              TEXT,
  revision_number         TEXT,
  drawing_project_number  TEXT,
  sheet_numbers           TEXT NOT NULL DEFAULT '[]',
  room_names_raw          TEXT NOT NULL DEFAULT '[]',
  additional_notes        TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_floor_plans_floor ON floor_plans(floor_id);

-- Rooms are seeded from drawing room numbers and confirmed or added in the
-- field, so they sync like devices do.
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,
  floor_id    TEXT NOT NULL REFERENCES floors(id),
  number      TEXT,
  name        TEXT,
  room_type   TEXT,
  notes       TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at  TEXT,
  CHECK (number IS NOT NULL OR name IS NOT NULL)
);
CREATE INDEX idx_rooms_floor ON rooms(floor_id);
CREATE UNIQUE INDEX idx_rooms_floor_number ON rooms(floor_id, number) WHERE number IS NOT NULL;

-- A unit of field work: one engineer's walk of a site or building.
CREATE TABLE surveys (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  site_id       TEXT NOT NULL REFERENCES sites(id),
  building_id   TEXT REFERENCES buildings(id),
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'in_progress', 'submitted', 'approved')),
  assigned_to   TEXT,
  notes         TEXT,
  started_at    TEXT,
  submitted_at  TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    TEXT
);
CREATE INDEX idx_surveys_project ON surveys(project_id);
CREATE INDEX idx_surveys_site ON surveys(site_id);

-- A device found or planned during a survey. pin_x / pin_y place it on a
-- floor plan as fractions (0–1) of the sheet's width and height, so the pin
-- stays put whatever resolution the plan is rendered at.
-- attributes holds category-specific fields (PoE class, port count, ...) as
-- JSON, so new device types need no migration.
CREATE TABLE devices (
  id                  TEXT PRIMARY KEY,
  survey_id           TEXT NOT NULL REFERENCES surveys(id),
  floor_id            TEXT REFERENCES floors(id),
  room_id             TEXT REFERENCES rooms(id),
  floor_plan_id       TEXT REFERENCES floor_plans(id),
  pin_x               REAL CHECK (pin_x BETWEEN 0 AND 1),
  pin_y               REAL CHECK (pin_y BETWEEN 0 AND 1),
  location_note       TEXT,
  category            TEXT NOT NULL,
  manufacturer        TEXT,
  model               TEXT,
  serial_number       TEXT,
  mac_address         TEXT,
  ip_address          TEXT,
  asset_tag           TEXT,
  mounting_type       TEXT
                        CHECK (mounting_type IN ('ceiling', 'wall', 'rack', 'desk', 'floor', 'pole', 'other')),
  mounting_height_ft  REAL,
  condition           TEXT
                        CHECK (condition IN ('existing', 'proposed', 'replace', 'remove')),
  notes               TEXT,
  attributes          TEXT NOT NULL DEFAULT '{}',
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at          TEXT,
  CHECK ((pin_x IS NULL) = (pin_y IS NULL)),
  CHECK (pin_x IS NULL OR floor_plan_id IS NOT NULL)
);
CREATE INDEX idx_devices_survey ON devices(survey_id);
CREATE INDEX idx_devices_floor ON devices(floor_id);
CREATE INDEX idx_devices_room ON devices(room_id);
CREATE INDEX idx_devices_mac ON devices(mac_address) WHERE mac_address IS NOT NULL;

-- A photo stored in R2. Attach it to a device, or to a room or the survey
-- for context shots (closet overview, ceiling, rack elevation).
CREATE TABLE photos (
  id            TEXT PRIMARY KEY,
  survey_id     TEXT NOT NULL REFERENCES surveys(id),
  device_id     TEXT REFERENCES devices(id),
  room_id       TEXT REFERENCES rooms(id),
  r2_key        TEXT NOT NULL UNIQUE,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER,
  width_px      INTEGER,
  height_px     INTEGER,
  caption       TEXT,
  taken_at      TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    TEXT
);
CREATE INDEX idx_photos_survey ON photos(survey_id);
CREATE INDEX idx_photos_device ON photos(device_id);
