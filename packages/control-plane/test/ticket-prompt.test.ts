import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketBranch, ticketPrompt } from "../src/ticket-prompt.ts";

test("the first prompt names the issue, carries its body, and asks for its branch and a draft pull request that closes it", () => {
  const issue = {
    number: 12,
    title: "Fix the login: it loops!",
    body: "Steps:\n1. sign in\n2. watch it loop",
    url: "https://github.com/acme/app/issues/12",
  };
  const branch = ticketBranch(issue);
  assert.equal(branch, "ticket/12-fix-the-login-it-loops");
  const prompt = ticketPrompt({ owner: "acme", repo: "app", issue, branch });
  assert.match(prompt, /#12 of acme\/app: Fix the login: it loops!/);
  assert.ok(prompt.includes(issue.url));
  assert.ok(prompt.includes(issue.body));
  assert.ok(prompt.includes(`branch ${branch}`));
  assert.ok(prompt.includes(`gh pr create --draft --head ${branch}`));
  assert.ok(prompt.includes(`Closes ${issue.url}`));
});

test("the branch slug keeps 40 characters of the title, lower case, without a dash at either end", () => {
  assert.equal(
    ticketBranch({ number: 7, title: "  Add the GitHub repository and issue listings -- for the dashboard" }),
    "ticket/7-add-the-github-repository-and-issue-list",
  );
  assert.equal(
    ticketBranch({ number: 8, title: "Rename the session turn table column ab cd" }),
    "ticket/8-rename-the-session-turn-table-column-ab",
  );
});
