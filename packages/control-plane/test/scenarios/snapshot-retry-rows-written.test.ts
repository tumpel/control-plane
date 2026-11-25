import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failsSnapshot,
  inWorld,
  type Placement,
  snapshotAsked,
  tree,
  uploadsChunks,
} from "./harness/snapshot-chunks.ts";

const LARGE = 100_000;
const ROWS_PER_FAILED_SNAPSHOT = 25;
const ROWS_PER_NEW_PACK = 2;

const packsOf = (count: number): number => new Set(tree(count).map((chunk) => chunk.packDigest)).size;

const rowsOfFailedSnapshot = (chunks: Placement[], attempts: number): Promise<number> =>
  inWorld(async (world, host) => {
    const session = await world.startSession({ prompt: "build the tree", tags: [] });
    const offer = host.takeOffer();
    await host.claims(offer);
    await host.completes(offer);
    const request = snapshotAsked(host, session.sessionId);
    const before = world.tenantRowsWritten();
    for (let attempt = 0; attempt < attempts; attempt++) {
      await uploadsChunks(world, host, request.snapshotId, chunks);
    }
    await failsSnapshot(host, request.snapshotId);
    return world.tenantRowsWritten() - before;
  });

test("a snapshot of 100000 chunks that the host uploads 3 times and then fails writes the rows of a one-chunk snapshot that fails at once, plus a count and a hold per pack", async () => {
  const large = (await rowsOfFailedSnapshot(tree(LARGE), 3)) - ROWS_PER_NEW_PACK * packsOf(LARGE);
  const small = (await rowsOfFailedSnapshot(tree(1), 1)) - ROWS_PER_NEW_PACK * packsOf(1);
  assert.equal(large, small);
  assert.ok(small <= ROWS_PER_FAILED_SNAPSHOT, `a failed snapshot wrote ${small} rows besides its packs`);
});
