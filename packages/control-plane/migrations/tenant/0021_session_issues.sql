CREATE TABLE session_issues (
  session_id TEXT PRIMARY KEY REFERENCES sessions (session_id),
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  html_url TEXT NOT NULL,
  branch TEXT NOT NULL
);
