# Public surface

Every operation a signed-in principal calls over REST is also one MCP tool and one CLI command,
backed by the same REST handler. `npm run surface` writes this file; `npm run surface:check`
fails when an operation lacks a tool or a command, or when this file is stale.

Naming: an operation `Group_op` is the tool `tumpel_<noun>_<verb>` and the command
`tumpel <noun> <verb>`, where the verb is `op` in kebab-case and the noun comes from the group:
Identity `(none)`, Devices `devices`, EnrolmentTokens `host`, Hosts `host`, HarnessCatalog `harness`, Personas `persona`, SecretSets `secret-set`, Sessions `session`, Turns `turn`, Transcripts `transcript`, Snapshots `snapshot`.
`EnrolmentTokens_mint` takes the verb `mint-token` and `Turns_getFailure` the verb `failure`. The CLI's
`transcript read` takes a turnId and reads that turn's lines of its session.

`tumpel_secret_set_create` and `_update` take key names and `valueFrom.env` names only and write
nothing: the server cannot read your environment, so they return the config entry for
`tumpel config apply`, which writes the values.

| Operation                 | MCP tool                     | CLI command                  |
| ------------------------- | ---------------------------- | ---------------------------- |
| `Devices_list`            | `tumpel_devices_list`        | `tumpel devices list`        |
| `Devices_revoke`          | `tumpel_devices_revoke`      | `tumpel devices revoke`      |
| `EnrolmentTokens_mint`    | `tumpel_host_mint_token`     | `tumpel host mint-token`     |
| `HarnessCatalog_list`     | `tumpel_harness_list`        | `tumpel harness list`        |
| `HarnessCatalog_listPins` | `tumpel_harness_list_pins`   | `tumpel harness list-pins`   |
| `HarnessCatalog_pin`      | `tumpel_harness_pin`         | `tumpel harness pin`         |
| `HarnessCatalog_unpin`    | `tumpel_harness_unpin`       | `tumpel harness unpin`       |
| `Hosts_get`               | `tumpel_host_get`            | `tumpel host get`            |
| `Hosts_list`              | `tumpel_host_list`           | `tumpel host list`           |
| `Hosts_revoke`            | `tumpel_host_revoke`         | `tumpel host revoke`         |
| `Hosts_setLabels`         | `tumpel_host_set_labels`     | `tumpel host set-labels`     |
| `Identity_whoami`         | `tumpel_whoami`              | `tumpel whoami`              |
| `Personas_create`         | `tumpel_persona_create`      | `tumpel persona create`      |
| `Personas_delete`         | `tumpel_persona_delete`      | `tumpel persona delete`      |
| `Personas_get`            | `tumpel_persona_get`         | `tumpel persona get`         |
| `Personas_list`           | `tumpel_persona_list`        | `tumpel persona list`        |
| `Personas_update`         | `tumpel_persona_update`      | `tumpel persona update`      |
| `Personas_uploadFile`     | `tumpel_persona_upload_file` | `tumpel persona upload-file` |
| `SecretSets_create`       | `tumpel_secret_set_create`   | `tumpel secret-set create`   |
| `SecretSets_delete`       | `tumpel_secret_set_delete`   | `tumpel secret-set delete`   |
| `SecretSets_get`          | `tumpel_secret_set_get`      | `tumpel secret-set get`      |
| `SecretSets_list`         | `tumpel_secret_set_list`     | `tumpel secret-set list`     |
| `SecretSets_update`       | `tumpel_secret_set_update`   | `tumpel secret-set update`   |
| `Sessions_get`            | `tumpel_session_get`         | `tumpel session get`         |
| `Sessions_list`           | `tumpel_session_list`        | `tumpel session list`        |
| `Sessions_start`          | `tumpel_session_start`       | `tumpel session start`       |
| `Snapshots_get`           | `tumpel_snapshot_get`        | `tumpel snapshot get`        |
| `Snapshots_list`          | `tumpel_snapshot_list`       | `tumpel snapshot list`       |
| `Transcripts_read`        | `tumpel_transcript_read`     | `tumpel transcript read`     |
| `Turns_get`               | `tumpel_turn_get`            | `tumpel turn get`            |
| `Turns_getFailure`        | `tumpel_turn_failure`        | `tumpel turn failure`        |
| `Turns_list`              | `tumpel_turn_list`           | `tumpel turn list`           |
| `Turns_send`              | `tumpel_turn_send`           | `tumpel turn send`           |

Excluded by rule:

- browser-only: signed in by the identity assertion: `DeviceFlow_approve`, `DeviceFlow_deny`, `Tenants_signUp`.
- OAuth, device-flow and enrolment wire: no principal: `WellKnown_authorizationServer`, `WellKnown_authorizationServerForMcp`, `WellKnown_protectedResource`, `WellKnown_protectedResourceForMcp`, `health`, `OAuth_authorize`, `OAuth_register`, `OAuth_token`, `DeviceFlow_start`, `DeviceFlow_token`, `Hosts_enrol`.
