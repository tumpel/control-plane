import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketBranch, ticketPrompt } from "../src/ticket-prompt.ts";

test("an issue becomes the first prompt npm run ticket wrote, word for word", () => {
  const issue = {
    number: 12,
    title: "Fix the login: it loops!",
    body: "Steps:\n1. sign in\n2. watch it loop",
    url: "https://github.com/acme/app/issues/12",
  };
  const branch = ticketBranch(issue);
  assert.equal(branch, "ticket/12-fix-the-login-it-loops");
  assert.equal(
    ticketPrompt({ owner: "acme", repo: "app", issue, branch }),
    [
      "Work GitHub issue #12 of acme/app: Fix the login: it loops!",
      "https://github.com/acme/app/issues/12",
      "",
      "Steps:",
      "1. sign in",
      "2. watch it loop",
      "",
      'The repository is cloned in your working directory at its default branch. Create the branch ticket/12-fix-the-login-it-loops from it and make the change the issue asks for, in one or more commits with conventional commit subjects. Push the branch to origin and open a draft pull request with gh pr create --draft --head ticket/12-fix-the-login-it-loops. Its title is a conventional commit subject, and its body is four short lines: what, why, how, and "Closes https://github.com/acme/app/issues/12". Print the pull request URL as the last line of your reply, then stop.',
    ].join("\n"),
  );
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
  assert.equal(ticketBranch({ number: 9, title: "!!!" }), "ticket/9-");
});
