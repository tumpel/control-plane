# Public surface

Every operation a signed-in principal calls over REST is also one MCP tool and one CLI command,
backed by the same REST handler. `npm run surface` writes this file; `npm run surface:check`
fails when an operation lacks a tool or a command, or when this file is stale.

Naming: an operation `Group_op` is the tool `tumpel_<noun>_<verb>` and the command
`tumpel <noun> <verb>`, where the verb is `op` in kebab-case and the noun comes from the group:
Identity `(none)`, Devices `devices`, EnrolmentTokens `host`, Hosts `host`, HarnessCatalog `harness`, Releases `release`, Personas `persona`, SecretSets `secret-set`, GitHubConnections `github`, IssuerTokens `issuer`, Sessions `session`, Turns `turn`, Transcripts `transcript`, Snapshots `snapshot`, Prebuilds `prebuild`.
`EnrolmentTokens_mint` takes the verb `mint-token`, `Turns_getFailure` and `Prebuilds_getFailure` the verb `failure`,
`Sessions_listCredentialHandovers` the verb `handovers` and `Sessions_listStopFailures` the verb
`stop-failures`. `Releases_current` needs no sign-in over REST and is listed because a signed-in
principal reads it too. The CLI's `transcript read` takes a turnId and reads that turn's lines of its
session; `session get` also prints the session's stop failures.

`tumpel_secret_set_create` and `_update` take key names and `valueFrom.env` names only and write
nothing: the server cannot read your environment, so they return the config entry for
`tumpel config apply`, which writes the values.

| Operation                          | MCP tool                       | CLI command                    |
| ---------------------------------- | ------------------------------ | ------------------------------ |
| `Devices_list`                     | `tumpel_devices_list`          | `tumpel devices list`          |
| `Devices_revoke`                   | `tumpel_devices_revoke`        | `tumpel devices revoke`        |
| `EnrolmentTokens_mint`             | `tumpel_host_mint_token`       | `tumpel host mint-token`       |
| `GitHubConnections_get`            | `tumpel_github_get`            | `tumpel github get`            |
| `GitHubConnections_start`          | `tumpel_github_start`          | `tumpel github start`          |
| `HarnessCatalog_list`              | `tumpel_harness_list`          | `tumpel harness list`          |
| `HarnessCatalog_listPins`          | `tumpel_harness_list_pins`     | `tumpel harness list-pins`     |
| `HarnessCatalog_pin`               | `tumpel_harness_pin`           | `tumpel harness pin`           |
| `HarnessCatalog_unpin`             | `tumpel_harness_unpin`         | `tumpel harness unpin`         |
| `Hosts_get`                        | `tumpel_host_get`              | `tumpel host get`              |
| `Hosts_list`                       | `tumpel_host_list`             | `tumpel host list`             |
| `Hosts_listUsage`                  | `tumpel_host_list_usage`       | `tumpel host list-usage`       |
| `Hosts_revoke`                     | `tumpel_host_revoke`           | `tumpel host revoke`           |
| `Hosts_setLabels`                  | `tumpel_host_set_labels`       | `tumpel host set-labels`       |
| `Identity_whoami`                  | `tumpel_whoami`                | `tumpel whoami`                |
| `IssuerTokens_mint`                | `tumpel_issuer_mint`           | `tumpel issuer mint`           |
| `Personas_create`                  | `tumpel_persona_create`        | `tumpel persona create`        |
| `Personas_delete`                  | `tumpel_persona_delete`        | `tumpel persona delete`        |
| `Personas_get`                     | `tumpel_persona_get`           | `tumpel persona get`           |
| `Personas_list`                    | `tumpel_persona_list`          | `tumpel persona list`          |
| `Personas_update`                  | `tumpel_persona_update`        | `tumpel persona update`        |
| `Personas_uploadFile`              | `tumpel_persona_upload_file`   | `tumpel persona upload-file`   |
| `Prebuilds_get`                    | `tumpel_prebuild_get`          | `tumpel prebuild get`          |
| `Prebuilds_getFailure`             | `tumpel_prebuild_failure`      | `tumpel prebuild failure`      |
| `Prebuilds_list`                   | `tumpel_prebuild_list`         | `tumpel prebuild list`         |
| `Prebuilds_start`                  | `tumpel_prebuild_start`        | `tumpel prebuild start`        |
| `Releases_current`                 | `tumpel_release_current`       | `tumpel release current`       |
| `SecretSets_create`                | `tumpel_secret_set_create`     | `tumpel secret-set create`     |
| `SecretSets_delete`                | `tumpel_secret_set_delete`     | `tumpel secret-set delete`     |
| `SecretSets_get`                   | `tumpel_secret_set_get`        | `tumpel secret-set get`        |
| `SecretSets_list`                  | `tumpel_secret_set_list`       | `tumpel secret-set list`       |
| `SecretSets_update`                | `tumpel_secret_set_update`     | `tumpel secret-set update`     |
| `Sessions_archive`                 | `tumpel_session_archive`       | `tumpel session archive`       |
| `Sessions_get`                     | `tumpel_session_get`           | `tumpel session get`           |
| `Sessions_list`                    | `tumpel_session_list`          | `tumpel session list`          |
| `Sessions_listCredentialHandovers` | `tumpel_session_handovers`     | `tumpel session handovers`     |
| `Sessions_listStopFailures`        | `tumpel_session_stop_failures` | `tumpel session stop-failures` |
| `Sessions_start`                   | `tumpel_session_start`         | `tumpel session start`         |
| `Sessions_stop`                    | `tumpel_session_stop`          | `tumpel session stop`          |
| `Snapshots_get`                    | `tumpel_snapshot_get`          | `tumpel snapshot get`          |
| `Snapshots_list`                   | `tumpel_snapshot_list`         | `tumpel snapshot list`         |
| `Transcripts_read`                 | `tumpel_transcript_read`       | `tumpel transcript read`       |
| `Turns_get`                        | `tumpel_turn_get`              | `tumpel turn get`              |
| `Turns_getFailure`                 | `tumpel_turn_failure`          | `tumpel turn failure`          |
| `Turns_list`                       | `tumpel_turn_list`             | `tumpel turn list`             |
| `Turns_send`                       | `tumpel_turn_send`             | `tumpel turn send`             |

Excluded by rule:

- browser-only: signed in by the identity assertion: `DeviceFlow_approve`, `DeviceFlow_deny`, `IssuerKeys_rotate`, `Tenants_signUp`.
- OAuth, device-flow, enrolment and host download wire: no principal: `WellKnown_jwks`, `WellKnown_authorizationServer`, `WellKnown_authorizationServerForMcp`, `WellKnown_protectedResource`, `WellKnown_protectedResourceForMcp`, `WellKnown_openIdConfiguration`, `health`, `OAuth_authorize`, `OAuth_register`, `OAuth_token`, `DeviceFlow_start`, `DeviceFlow_token`, `Hosts_enrol`, `Releases_supervisor`.
