export type ConnectorUse = { connector_id: string; name: string; url: string; usable: number };

const USE_SELECT = `SELECT n.connector_id, n.name, COALESCE(s.url, o.url) AS url,
  (d.connector_id IS NULL AND (t.connector_id IS NOT NULL OR g.connector_id IS NOT NULL)) AS usable
  FROM connector_names n
  LEFT JOIN static_connectors s USING (connector_id)
  LEFT JOIN oauth_connectors o USING (connector_id)
  LEFT JOIN static_connector_tokens t USING (connector_id)
  LEFT JOIN oauth_connector_grants g USING (connector_id)
  LEFT JOIN connector_disconnections d USING (connector_id)`;

export const personaConnectorUses = (sql: SqlStorage, personaId: string): ConnectorUse[] =>
  sql
    .exec<ConnectorUse>(
      `${USE_SELECT} WHERE n.connector_id IN (SELECT connector_id FROM persona_connectors WHERE persona_id = ?) ORDER BY n.name`,
      personaId,
    )
    .toArray();

export const sessionConnectorUses = (sql: SqlStorage, sessionId: string): ConnectorUse[] =>
  sql
    .exec<ConnectorUse>(
      `${USE_SELECT} WHERE n.connector_id IN (SELECT connector_id FROM session_connectors WHERE session_id = ?) ORDER BY n.name`,
      sessionId,
    )
    .toArray();

export const copyPersonaConnectors = (sql: SqlStorage, sessionId: string, personaId: string): void => {
  sql.exec(
    "INSERT INTO session_connectors (session_id, connector_id) SELECT ?, connector_id FROM persona_connectors WHERE persona_id = ?",
    sessionId,
    personaId,
  );
};

const RELEASED = `connector_id IN (SELECT connector_id FROM connector_disconnections)
  AND connector_id NOT IN (SELECT sc.connector_id FROM session_connectors sc JOIN turns t ON t.session_id = sc.session_id WHERE t.state = 'Running')`;

export const releaseConnectorCredentials = (sql: SqlStorage): void => {
  sql.exec(`DELETE FROM static_connector_tokens WHERE ${RELEASED}`);
  sql.exec(`DELETE FROM oauth_connector_grants WHERE ${RELEASED}`);
};

export const disconnectedDetail = (names: readonly string[]): string =>
  `the session uses the connector ${names.join(", ")}, which is not connected`;

export const DISCONNECTED_FIX =
  "An Owner connects it again, or the session's persona drops it; start a new session once the persona lists only connected connectors";
