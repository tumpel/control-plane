CREATE TABLE github_account_lists (
  list_slot INTEGER PRIMARY KEY CHECK (list_slot = 1),
  accounts TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL
);
