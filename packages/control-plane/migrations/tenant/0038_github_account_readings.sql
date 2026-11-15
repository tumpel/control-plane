DROP TABLE github_account_lists;

CREATE TABLE github_account_readings (
  reading_slot INTEGER PRIMARY KEY CHECK (reading_slot = 1),
  reading TEXT NOT NULL,
  read_at INTEGER NOT NULL
);

CREATE TABLE github_install_requests (
  github_account_id INTEGER PRIMARY KEY,
  requested_at INTEGER NOT NULL
);
