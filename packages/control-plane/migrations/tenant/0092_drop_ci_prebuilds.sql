DROP TABLE prebuild_upload_jobs;
DROP TABLE prebuild_pipelines;
DROP TABLE prebuild_runs;
DROP TABLE prebuild_uploads;

DELETE FROM prebuilds
WHERE provider IN ('GitHubActions', 'CircleCI')
  AND prebuild_id NOT IN (SELECT prebuild_id FROM prebuild_layers)
  AND prebuild_id NOT IN (SELECT prebuild_id FROM prebuild_failures)
  AND prebuild_id NOT IN (SELECT prebuild_id FROM prebuild_sessions);

DROP TABLE circleci_authorization_failures;
DROP TABLE circleci_authorization_completions;
DROP TABLE circleci_authorization_tokens;
DROP TABLE circleci_authorizations;
DROP TABLE circleci_token_expiries;
DROP TABLE circleci_clients;
DROP TABLE circleci_projects;
DROP TABLE circleci_connections;
DROP TABLE github_actions_connections;
