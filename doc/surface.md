# Public surface

Every tenant operation is one MCP tool and one CLI command, backed by the same REST handler, so an
MCP session sets up and runs a whole tenant. `npm run surface` writes this file; `npm run surface:check`
fails when an operation lacks a tool or a command and is not on the allowlist, when an allowlist entry
names no operation or one that has a tool, or when this file is stale.

Naming: an operation `Group_op` is the tool `tumpel_<noun>_<verb>` and the command
`tumpel <noun> <verb>`, where the verb is `op` in kebab-case and the noun comes from the group:
Identity `(none)`, Devices `devices`, Members `member`, Invitations `invitation`, EnrolmentTokens `host`, Hosts `host`, HarnessCatalog `harness`, Releases `release`, Personas `persona`, SecretSets `secret-set`, GitHubConnections `github`, Sessions `session`, Turns `turn`, Transcripts `transcript`, Snapshots `snapshot`, Prebuilds `prebuild`, Connections `connection`, GitHubActionsConnections `github-actions`, NamespaceConnections `namespace`, TenantConfigs `config`, OAuthGrants `oauth-grant`.
`EnrolmentTokens_mint` takes the verb `mint-token`, `Turns_getFailure` and `Prebuilds_getFailure` the verb `failure`,
`Sessions_listCredentialHandovers` the verb `handovers` and `Sessions_listStopFailures` the verb
`stop-failures`. `Releases_current` needs no sign-in over REST and is listed because a signed-in
principal reads it too. The CLI's `transcript read` takes a turnId and reads that turn's lines of its
session; `session get` also prints the session's stop failures.

`tumpel_secret_set_create` and `_update` take key names and `valueFrom.env` names only and write
nothing: the server cannot read your environment, so they return the config entry for
`tumpel config apply`, which writes the values.

| Operation                            | MCP tool                          | CLI command                       |
| ------------------------------------ | --------------------------------- | --------------------------------- |
| `Connections_list`                   | `tumpel_connection_list`          | `tumpel connection list`          |
| `Devices_list`                       | `tumpel_devices_list`             | `tumpel devices list`             |
| `Devices_revoke`                     | `tumpel_devices_revoke`           | `tumpel devices revoke`           |
| `EnrolmentTokens_mint`               | `tumpel_host_mint_token`          | `tumpel host mint-token`          |
| `GitHubActionsConnections_delete`    | `tumpel_github_actions_delete`    | `tumpel github-actions delete`    |
| `GitHubActionsConnections_get`       | `tumpel_github_actions_get`       | `tumpel github-actions get`       |
| `GitHubActionsConnections_start`     | `tumpel_github_actions_start`     | `tumpel github-actions start`     |
| `GitHubConnections_delete`           | `tumpel_github_delete`            | `tumpel github delete`            |
| `GitHubConnections_get`              | `tumpel_github_get`               | `tumpel github get`               |
| `GitHubConnections_listIssues`       | `tumpel_github_list_issues`       | `tumpel github list-issues`       |
| `GitHubConnections_listRepositories` | `tumpel_github_list_repositories` | `tumpel github list-repositories` |
| `GitHubConnections_start`            | `tumpel_github_start`             | `tumpel github start`             |
| `HarnessCatalog_list`                | `tumpel_harness_list`             | `tumpel harness list`             |
| `HarnessCatalog_listPins`            | `tumpel_harness_list_pins`        | `tumpel harness list-pins`        |
| `HarnessCatalog_pin`                 | `tumpel_harness_pin`              | `tumpel harness pin`              |
| `HarnessCatalog_unpin`               | `tumpel_harness_unpin`            | `tumpel harness unpin`            |
| `Hosts_get`                          | `tumpel_host_get`                 | `tumpel host get`                 |
| `Hosts_list`                         | `tumpel_host_list`                | `tumpel host list`                |
| `Hosts_listUsage`                    | `tumpel_host_list_usage`          | `tumpel host list-usage`          |
| `Hosts_revoke`                       | `tumpel_host_revoke`              | `tumpel host revoke`              |
| `Hosts_setLabels`                    | `tumpel_host_set_labels`          | `tumpel host set-labels`          |
| `Identity_listTenants`               | `tumpel_tenants`                  | `tumpel tenants`                  |
| `Identity_whoami`                    | `tumpel_whoami`                   | `tumpel whoami`                   |
| `Invitations_create`                 | `tumpel_invitation_create`        | `tumpel invitation create`        |
| `Invitations_list`                   | `tumpel_invitation_list`          | `tumpel invitation list`          |
| `Invitations_revoke`                 | `tumpel_invitation_revoke`        | `tumpel invitation revoke`        |
| `Members_list`                       | `tumpel_member_list`              | `tumpel member list`              |
| `Members_remove`                     | `tumpel_member_remove`            | `tumpel member remove`            |
| `NamespaceConnections_delete`        | `tumpel_namespace_delete`         | `tumpel namespace delete`         |
| `NamespaceConnections_get`           | `tumpel_namespace_get`            | `tumpel namespace get`            |
| `NamespaceConnections_start`         | `tumpel_namespace_start`          | `tumpel namespace start`          |
| `OAuthGrants_list`                   | `tumpel_oauth_grant_list`         | `tumpel oauth-grant list`         |
| `Personas_create`                    | `tumpel_persona_create`           | `tumpel persona create`           |
| `Personas_delete`                    | `tumpel_persona_delete`           | `tumpel persona delete`           |
| `Personas_get`                       | `tumpel_persona_get`              | `tumpel persona get`              |
| `Personas_list`                      | `tumpel_persona_list`             | `tumpel persona list`             |
| `Personas_update`                    | `tumpel_persona_update`           | `tumpel persona update`           |
| `Personas_uploadFile`                | `tumpel_persona_upload_file`      | `tumpel persona upload-file`      |
| `Prebuilds_get`                      | `tumpel_prebuild_get`             | `tumpel prebuild get`             |
| `Prebuilds_getFailure`               | `tumpel_prebuild_failure`         | `tumpel prebuild failure`         |
| `Prebuilds_list`                     | `tumpel_prebuild_list`            | `tumpel prebuild list`            |
| `Prebuilds_listLatest`               | `tumpel_prebuild_list_latest`     | `tumpel prebuild list-latest`     |
| `Prebuilds_start`                    | `tumpel_prebuild_start`           | `tumpel prebuild start`           |
| `Releases_current`                   | `tumpel_release_current`          | `tumpel release current`          |
| `SecretSets_create`                  | `tumpel_secret_set_create`        | `tumpel secret-set create`        |
| `SecretSets_delete`                  | `tumpel_secret_set_delete`        | `tumpel secret-set delete`        |
| `SecretSets_get`                     | `tumpel_secret_set_get`           | `tumpel secret-set get`           |
| `SecretSets_list`                    | `tumpel_secret_set_list`          | `tumpel secret-set list`          |
| `SecretSets_update`                  | `tumpel_secret_set_update`        | `tumpel secret-set update`        |
| `Sessions_archive`                   | `tumpel_session_archive`          | `tumpel session archive`          |
| `Sessions_get`                       | `tumpel_session_get`              | `tumpel session get`              |
| `Sessions_list`                      | `tumpel_session_list`             | `tumpel session list`             |
| `Sessions_listCredentialHandovers`   | `tumpel_session_handovers`        | `tumpel session handovers`        |
| `Sessions_listStopFailures`          | `tumpel_session_stop_failures`    | `tumpel session stop-failures`    |
| `Sessions_start`                     | `tumpel_session_start`            | `tumpel session start`            |
| `Sessions_startFromIssue`            | `tumpel_session_start_from_issue` | `tumpel session start-from-issue` |
| `Sessions_stop`                      | `tumpel_session_stop`             | `tumpel session stop`             |
| `Snapshots_get`                      | `tumpel_snapshot_get`             | `tumpel snapshot get`             |
| `Snapshots_list`                     | `tumpel_snapshot_list`            | `tumpel snapshot list`            |
| `TenantConfigs_apply`                | `tumpel_config_apply`             | `tumpel config apply`             |
| `TenantConfigs_plan`                 | `tumpel_config_plan`              | `tumpel config plan`              |
| `Transcripts_read`                   | `tumpel_transcript_read`          | `tumpel transcript read`          |
| `Turns_get`                          | `tumpel_turn_get`                 | `tumpel turn get`                 |
| `Turns_getFailure`                   | `tumpel_turn_failure`             | `tumpel turn failure`             |
| `Turns_list`                         | `tumpel_turn_list`                | `tumpel turn list`                |
| `Turns_send`                         | `tumpel_turn_send`                | `tumpel turn send`                |

Allowlist: operations that are not tenant operations, with no tool or command:

- `DeviceFlow_approve`: browser-only page behind the identity-aware proxy, signed in by its assertion.
- `DeviceFlow_deny`: browser-only page behind the identity-aware proxy, signed in by its assertion.
- `Invitations_accept`: browser-only page behind the identity-aware proxy, signed in by its assertion.
- `IssuerKeys_rotate`: operator page behind the identity-aware proxy that rotates the stage's issuer keys.
- `Tenants_signUp`: browser-only page behind the identity-aware proxy, signed in by its assertion.
- `WellKnown_jwks`: OAuth and OpenID discovery document a client reads before it signs in.
- `WellKnown_authorizationServer`: OAuth and OpenID discovery document a client reads before it signs in.
- `WellKnown_authorizationServerForMcp`: OAuth and OpenID discovery document a client reads before it signs in.
- `WellKnown_protectedResource`: OAuth and OpenID discovery document a client reads before it signs in.
- `WellKnown_protectedResourceForMcp`: OAuth and OpenID discovery document a client reads before it signs in.
- `WellKnown_openIdConfiguration`: OAuth and OpenID discovery document a client reads before it signs in.
- `OAuth_authorize`: OAuth wire a client signs in with before it holds a token.
- `OAuth_register`: OAuth wire a client signs in with before it holds a token.
- `OAuth_revoke`: OAuth wire a client signs in with before it holds a token.
- `OAuth_token`: OAuth wire a client signs in with before it holds a token.
- `DeviceFlow_start`: device-code wire the CLI signs in with before it holds a token.
- `DeviceFlow_token`: device-code wire the CLI signs in with before it holds a token.
- `health`: liveness probe of the control plane, no principal.
- `Hosts_enrol`: host channel: the supervisor trades its one-time enrolment token for the host's identity.
- `Releases_cli`: release download the installer and the supervisor fetch without sign-in.
- `Releases_supervisor`: release download the installer and the supervisor fetch without sign-in.
- `PrebuildUploads_start`: build job wire, signed by the provider's OIDC job token, never by a principal.
- `PrebuildUploads_complete`: build job wire, signed by the provider's OIDC job token, never by a principal.
