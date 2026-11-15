DELETE FROM github_installers WHERE installation_id IN (
  SELECT installation_id FROM github_installations AS older WHERE EXISTS (
    SELECT 1 FROM github_installations AS newer
    WHERE newer.account_login = older.account_login COLLATE NOCASE AND newer.installation_id > older.installation_id
  )
);

DELETE FROM github_installations WHERE EXISTS (
  SELECT 1 FROM github_installations AS newer
  WHERE newer.account_login = github_installations.account_login COLLATE NOCASE
  AND newer.installation_id > github_installations.installation_id
);

CREATE UNIQUE INDEX github_installations_by_account ON github_installations (account_login COLLATE NOCASE);
