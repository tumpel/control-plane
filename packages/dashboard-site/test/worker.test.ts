import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness, type TestHarness } from "wrangler";

let server: TestHarness;

before(async () => {
  server = createTestHarness({
    workers: [
      {
        config: {
          name: "tumpel-dashboard-test",
          main: fileURLToPath(new URL("../worker.ts", import.meta.url)),
          compatibility_date: "2026-10-01",
          assets: {
            directory: fileURLToPath(new URL("fixtures", import.meta.url)),
            binding: "ASSETS",
            run_worker_first: true,
            not_found_handling: "single-page-application",
          },
          vars: { API_ORIGIN: "https://api.example.com" },
        },
      },
    ],
  });
  await server.listen();
});

after(async () => {
  await server?.close();
});

test("the index carries the API origin meta tag in its head", async () => {
  const response = await server.fetch("https://tumpel.test/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<head>\s*<meta name="tumpel-api-origin" content="https:\/\/api\.example\.com">/);
});

test("a deep link answered by the single-page fallback carries the API origin meta tag", async () => {
  const response = await server.fetch("https://tumpel.test/hosts/h-1/sessions");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<head>\s*<meta name="tumpel-api-origin" content="https:\/\/api\.example\.com">/);
});
