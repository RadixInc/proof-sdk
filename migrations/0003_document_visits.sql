-- Personal library (issue #15): per-SSO-identity visit tracking. Library
-- queries are D1-only (visits joined against the documents index) — no DO
-- fan-out.
CREATE TABLE IF NOT EXISTS document_visits (
  user_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  role TEXT,
  visit_count INTEGER NOT NULL DEFAULT 1,
  first_visited_at TEXT NOT NULL,
  last_visited_at TEXT NOT NULL,
  PRIMARY KEY (user_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_document_visits_user_recency
  ON document_visits(user_id, last_visited_at);
