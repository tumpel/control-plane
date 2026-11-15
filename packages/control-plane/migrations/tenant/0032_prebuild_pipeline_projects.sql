CREATE TABLE prebuild_pipelines_next (
  prebuild_id TEXT PRIMARY KEY REFERENCES prebuilds (prebuild_id),
  pipeline_id TEXT NOT NULL UNIQUE,
  circleci_project_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO prebuild_pipelines_next (prebuild_id, pipeline_id, circleci_project_id, project_id, head_sha, created_at)
SELECT prebuild_pipelines.prebuild_id, prebuild_pipelines.pipeline_id, prebuild_pipelines.circleci_project_id,
  circleci_projects.project_id, prebuild_pipelines.head_sha, prebuild_pipelines.created_at
FROM prebuild_pipelines JOIN circleci_projects USING (circleci_project_id);

DROP TABLE prebuild_pipelines;

ALTER TABLE prebuild_pipelines_next RENAME TO prebuild_pipelines;

CREATE UNIQUE INDEX circleci_projects_project_id ON circleci_projects (project_id);
