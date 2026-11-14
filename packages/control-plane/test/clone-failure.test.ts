import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneFailureDetail } from "../src/clone-failure.ts";

test("a clone that ran without GITHUB_TOKEN asks for the token in the persona's secret set", () => {
  const detail = cloneFailureDetail(
    "cloning https://github.com/acme/private without GITHUB_TOKEN failed (exit status: 128); git reported: fatal: could not read Username",
    "work",
  );
  assert.match(detail, /needs a Variable member GITHUB_TOKEN with read and write access in secret set work/);
});

test("a clone that timed out or ran with the token names only the secret set", () => {
  for (const hostDetail of [
    "cloning https://github.com/acme/big did not finish within 120 s (cloneSeconds in /etc/tumpel/guest.json), so git was stopped; check that the repository host answers from the box",
    "the harness working directory /work holds files but no repository; rebuild the image so the directory starts empty",
    "cloning https://github.com/acme/private with GITHUB_TOKEN failed (exit status: 128); git reported: fatal: Authentication failed",
  ]) {
    const detail = cloneFailureDetail(hostDetail, "work");
    assert.equal(detail, `${hostDetail}. The persona runs on secret set work`);
  }
});
