import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelProtocol } from "@tumpel/schemas";
import { z } from "zod";
import { snapshotAsked } from "./harness/snapshot-chunks.ts";
import { UNMETERED, World } from "./harness/world.ts";

const ROWS_PER_FAILED_SNAPSHOT = 25;
const HOST_REPORT = "host host-1 answered BoxGone for box";

test("a BoxGone for the box of a Running session fails its snapshot and its turn with the host's report", async (t) => {
  const world = await World.open({ limits: UNMETERED });
  t.after(() => world.close());
  const host = await world.online(world.owner, "host-1", { protocolVersion: ChannelProtocol.Oldest });
  host.quiet();
  const session = await world.startSession({ prompt: "lose the box after the turn", tags: [] });
  const offer = host.takeOffer();
  await host.claims(offer);
  await host.completes(offer);
  const request = snapshotAsked(host, session.sessionId);
  const before = world.tenantRowsWritten();

  await host.says({ type: "BoxGone", sessionId: offer.sessionId, boxId: offer.boxId });
  await host.beats({ heldTurnIds: [], heldSessionIds: [] });

  const written = world.tenantRowsWritten() - before;
  const events = z
    .array(z.object({ payload: z.string() }))
    .parse(
      world
        .tenantSql()
        .exec(
          "SELECT payload FROM events JOIN event_sessions USING (event_id) WHERE session_id = ? ORDER BY event_id",
          offer.sessionId,
        )
        .toArray(),
    )
    .map((row) => z.object({ event: z.string(), detail: z.string().optional() }).parse(JSON.parse(row.payload)));
  const failure = z
    .array(z.object({ reason: z.string(), detail: z.string() }))
    .parse(
      world
        .tenantSql()
        .exec("SELECT reason, detail FROM snapshot_failures WHERE snapshot_id = ?", request.snapshotId)
        .toArray(),
    );
  const turn = await world.turn(offer.turnId);

  assert.ok(
    events.some((event) => event.event === "TurnFailed" && event.detail?.includes(HOST_REPORT) === true),
    `the session's events hold no TurnFailed with the host's report: ${JSON.stringify(events)}`,
  );
  assert.equal(events.at(-1)?.event, "SessionStopped");
  assert.equal(failure.length, 1);
  assert.equal(failure[0]?.reason, "BoxNotFound");
  assert.ok(failure[0]?.detail.startsWith(`${HOST_REPORT} ${offer.boxId}`), failure[0]?.detail);
  assert.equal(turn.state, "Failed");
  assert.equal(turn.state === "Failed" ? turn.reason : null, "SnapshotNotStored");
  assert.ok(turn.state === "Failed" && turn.detail.includes(HOST_REPORT), JSON.stringify(turn));
  assert.equal((await world.session(offer.sessionId)).state, "Stopped");
  assert.ok(written <= ROWS_PER_FAILED_SNAPSHOT + 1, `a BoxGone on a Running session wrote ${written} rows`);
});
