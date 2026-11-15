CREATE TABLE circleci_connections (
  connection_slot INTEGER PRIMARY KEY CHECK (connection_slot = 1),
  circleci_connection_id TEXT NOT NULL,
  account_label TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  api_token_sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE circleci_projects (
  circleci_project_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL UNIQUE,
  project_slug TEXT NOT NULL,
  project_id TEXT NOT NULL,
  pipeline_definition_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
