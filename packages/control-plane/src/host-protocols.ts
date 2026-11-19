import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types/index.ts";
import type { HostSchema } from "@tumpel/schemas";
import type { z } from "zod";
import type { Welcomed } from "./channel/control.ts";

type Host = z.infer<typeof HostSchema>;
export type HostProtocols = Pick<Host, "channelProtocol" | "guestProtocol">;
export type ChannelProtocolCount = { channelProtocolVersion: number; hostCount: number };

export const NO_PROTOCOLS: HostProtocols = {
  channelProtocol: { state: "NotReported" },
  guestProtocol: { state: "NotReported" },
};

export const recordProtocols = (
  db: D1Database,
  hostId: string,
  { channelProtocol, guestProtocol }: Pick<Welcomed, "channelProtocol" | "guestProtocol">,
  now: number,
): D1PreparedStatement[] => [
  db
    .prepare(
      `INSERT INTO host_channel_protocols (host_id, channel_protocol_oldest, channel_protocol_version, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (host_id) DO UPDATE SET channel_protocol_oldest = excluded.channel_protocol_oldest,
        channel_protocol_version = excluded.channel_protocol_version, updated_at = excluded.updated_at`,
    )
    .bind(hostId, channelProtocol.channelProtocolOldest, channelProtocol.channelProtocolVersion, now),
  guestProtocol.state === "NotReported"
    ? db.prepare("DELETE FROM host_guest_protocols WHERE host_id = ?").bind(hostId)
    : db
        .prepare(
          `INSERT INTO host_guest_protocols (host_id, guest_protocol_oldest, guest_protocol_version, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (host_id) DO UPDATE SET guest_protocol_oldest = excluded.guest_protocol_oldest,
            guest_protocol_version = excluded.guest_protocol_version, updated_at = excluded.updated_at`,
        )
        .bind(hostId, guestProtocol.guestProtocolOldest, guestProtocol.guestProtocolVersion, now),
];

export const protocolsOf = async (db: D1Database, hostIds: string[]): Promise<Record<string, HostProtocols>> => {
  const ids = JSON.stringify(hostIds);
  const [channel, guest] = await Promise.all([
    db
      .prepare(
        `SELECT host_id, channel_protocol_oldest, channel_protocol_version FROM host_channel_protocols
        WHERE host_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(ids)
      .all<{ host_id: string; channel_protocol_oldest: number; channel_protocol_version: number }>(),
    db
      .prepare(
        `SELECT host_id, guest_protocol_oldest, guest_protocol_version FROM host_guest_protocols
        WHERE host_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(ids)
      .all<{ host_id: string; guest_protocol_oldest: number; guest_protocol_version: number }>(),
  ]);
  const byHost: Record<string, HostProtocols> = Object.fromEntries(hostIds.map((hostId) => [hostId, NO_PROTOCOLS]));
  for (const row of channel.results) {
    byHost[row.host_id] = {
      ...NO_PROTOCOLS,
      channelProtocol: {
        state: "Reported",
        channelProtocolOldest: row.channel_protocol_oldest,
        channelProtocolVersion: row.channel_protocol_version,
      },
    };
  }
  for (const row of guest.results) {
    byHost[row.host_id] = {
      ...(byHost[row.host_id] ?? NO_PROTOCOLS),
      guestProtocol: {
        state: "Reported",
        guestProtocolOldest: row.guest_protocol_oldest,
        guestProtocolVersion: row.guest_protocol_version,
      },
    };
  }
  return byHost;
};

export const onlineChannelProtocols = async (db: D1Database): Promise<ChannelProtocolCount[]> => {
  const { results } = await db
    .prepare(
      `SELECT p.channel_protocol_version, COUNT(*) AS host_count
      FROM host_channel_protocols p JOIN hosts h ON h.host_id = p.host_id
      WHERE h.state = 'Online'
      GROUP BY p.channel_protocol_version ORDER BY p.channel_protocol_version`,
    )
    .all<{ channel_protocol_version: number; host_count: number }>();
  return results.map((row) => ({ channelProtocolVersion: row.channel_protocol_version, hostCount: row.host_count }));
};
