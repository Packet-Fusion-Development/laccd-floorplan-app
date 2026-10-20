-- The record form asks for Building and Floor up front. Many buildings in a
-- city or company environment have no floors or drawings on file, so a
-- device needs its own building reference rather than only inheriting one
-- through floor_id.
ALTER TABLE devices ADD COLUMN building_id TEXT REFERENCES buildings(id);
