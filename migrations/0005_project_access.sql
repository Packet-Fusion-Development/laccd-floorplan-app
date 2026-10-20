-- Customer access to a project's results page.
--
-- Packet Fusion staff (INTERNAL_DOMAINS) see every project. Anyone else sees
-- only the results of projects listed for them here, and nothing else in the
-- app: the Worker refuses every other route for them.
--
-- principal is either one address ("jane@customer.edu") or a whole domain
-- ("@customer.edu"), always stored lower-case.
CREATE TABLE project_access (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  principal   TEXT NOT NULL CHECK (principal LIKE '%@%'),
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, principal)
);
CREATE INDEX idx_project_access_principal ON project_access(principal);
