-- Global document index (D1). Content lives in each document's DO SQLite;
-- this table exists for cross-document queries (library, listings).
CREATE TABLE IF NOT EXISTS documents (
  slug TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL UNIQUE,
  title TEXT,
  share_state TEXT NOT NULL DEFAULT 'ACTIVE',
  owner_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at);
