-- Durability slice (issue #8): the DO refreshes the index row's revision on
-- every projection persist so cross-document listings can show freshness.
ALTER TABLE documents ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
