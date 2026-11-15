export interface TicketIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface Ticket {
  owner: string;
  repo: string;
  issue: TicketIssue;
  branch: string;
}

export const ticketSlug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

export const ticketBranch = (issue: Pick<TicketIssue, "number" | "title">): string =>
  `ticket/${issue.number}-${ticketSlug(issue.title)}`;

export const ticketPrompt = ({
  owner,
  repo,
  issue,
  branch,
}: Ticket): string => `Work GitHub issue #${issue.number} of ${owner}/${repo}: ${issue.title}
${issue.url}

${issue.body}

The repository is cloned in your working directory at its default branch. Create the branch ${branch} from it and make the change the issue asks for, in one or more commits with conventional commit subjects. Push the branch to origin and open a draft pull request with gh pr create --draft --head ${branch}. Its title is a conventional commit subject, and its body is four short lines: what, why, how, and "Closes ${issue.url}". Print the pull request URL as the last line of your reply, then stop.`;
