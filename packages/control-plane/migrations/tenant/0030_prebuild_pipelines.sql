DROP TABLE circleci_projects;

CREATE TABLE circleci_projects (
  circleci_project_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL UNIQUE,
  project_slug TEXT NOT NULL,
  project_id TEXT NOT NULL,
  pipeline_definition_id TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  signing_secret_sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE prebuild_pipelines (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  pipeline_id TEXT NOT NULL UNIQUE,
  circleci_project_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
