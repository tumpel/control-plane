CREATE TABLE github_apps (
  github_app_slot INTEGER PRIMARY KEY CHECK (github_app_slot = 1),
  app_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  client_id TEXT NOT NULL,
  owner_login TEXT NOT NULL,
  html_url TEXT NOT NULL,
  wrapped_data_key TEXT NOT NULL,
  client_secret_sealed TEXT NOT NULL,
  webhook_secret_sealed TEXT NOT NULL,
  private_key_sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE github_installations (
  installation_id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants (tenant_id),
  account_login TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
