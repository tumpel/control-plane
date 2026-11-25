-- bulk-data-reviewed: one pack digest and count per live pack and one per pack of an upload in flight; a frame writes only the packs whose count changes
CREATE TABLE pack_refs (
  pack_digest TEXT PRIMARY KEY,
  refs INTEGER NOT NULL CHECK (refs >= 0)
) WITHOUT ROWID;
CREATE TABLE pack_holds (
  session_id TEXT NOT NULL,
  pack_digest TEXT NOT NULL REFERENCES pack_refs (pack_digest),
  uploaded INTEGER NOT NULL CHECK (uploaded IN (0, 1)),
  PRIMARY KEY (session_id, pack_digest)
) WITHOUT ROWID;
CREATE TABLE pack_refs_imported (
  import_slot INTEGER PRIMARY KEY CHECK (import_slot = 1),
  imported_at INTEGER NOT NULL
);
