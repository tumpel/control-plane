export const CONSENT_CSRF_COOKIE = "__Host-tumpel_connect";

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const PAGE_STYLE =
  "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem;margin:.25rem 0}code{font-size:1.4rem}";

const page = (status: number, title: string, body: string, headers: Record<string, string> = {}): Response =>
  htmlDocument(status, title, PAGE_STYLE, `<h1>${escapeHtml(title)}</h1>${body}`, headers);

const htmlDocument = (
  status: number,
  title: string,
  style: string,
  body: string,
  headers: Record<string, string> = {},
): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · tumpel</title>
<style>${style}</style></head>
<body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self' https:",
        ...headers,
      },
    },
  );

export const messagePage = (status: number, title: string, text: string): Response =>
  page(status, title, `<p>${escapeHtml(text)}</p>`);

const POST_JSON = `async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const answer = response.status === 204 ? {} : await response.json();
  document.getElementById("result").textContent = response.ok ? "" : answer.detail + ". " + answer.fix;
  return response.ok ? answer : null;
}`;

const REPORT_ISSUE_URL = "https://github.com/mvhenten/tumpel/issues/new";

const SETUP_STEPS = ["Tenant", "GitHub", "Host", "claude.ai", "Persona", "Done"];

const WIZARD_STYLE = `:root{color-scheme:light dark;--fg:#1c1917;--muted:#57534e;--line:#d6d3d1;--card:#fff;--bg:#f5f5f4;--accent:#1c1917;--danger:#b91c1c}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#1c1917;--bg:#0c0a09;--accent:#f5f5f4;--danger:#f87171}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--card);border-bottom:1px solid var(--line)}
header strong{font-size:15px}header .where{color:var(--muted);font-size:14px}header .who{margin-left:auto;color:var(--muted);font-size:13px;overflow-wrap:anywhere;text-align:right}
main{max-width:40rem;margin:0 auto;padding:24px 16px 48px}
ol.steps{display:flex;list-style:none;margin:0 0 20px;padding:0;gap:4px}ol.steps li{flex:1;text-align:center;font-size:13px;color:var(--muted)}
ol.steps li::before{content:attr(data-n);display:grid;place-items:center;margin:0 auto 4px;width:26px;height:26px;border-radius:50%;border:1px solid var(--line);background:var(--card)}
ol.steps li[aria-current]{color:var(--fg);font-weight:600}ol.steps li[aria-current]::before{border:2px solid var(--accent)}
.count{display:none;color:var(--muted);font-size:13px;margin:0 0 12px}
@media (max-width:40rem){ol.steps li{font-size:0}ol.steps li::before{font-size:12px}.count{display:block}header .where{display:none}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px}
h1{font-size:22px;margin:0 0 4px}.lead{color:var(--muted);margin:0 0 20px}
label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
input{font:inherit;width:100%;min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
input[aria-invalid=true]{border:2px solid var(--danger)}
.hint{font-size:13px;color:var(--muted);margin:6px 0 20px}.hint.error{color:var(--danger);font-weight:600}
button{font:inherit;font-weight:600;min-height:44px;padding:8px 20px;border:0;border-radius:6px;background:var(--accent);color:var(--card);cursor:pointer}
button:disabled{opacity:.6;cursor:progress}
@media (max-width:40rem){button{width:100%;min-height:48px}}
.problem{border:2px solid var(--danger);border-radius:8px;padding:12px 16px;margin:0 0 20px}.problem h2{font-size:15px;margin:0 0 4px}.problem p{margin:0 0 4px;font-size:14px}
.problem a{font-size:14px;color:var(--fg)}`;

export const signUpPage = (email: string): Response =>
  htmlDocument(
    200,
    "Name your tenant",
    WIZARD_STYLE,
    `<header><strong>Tumpel</strong><span class="where">Create your tenant</span><span class="who">Signed in as ${escapeHtml(email)}</span></header>
<main>
<ol class="steps" aria-label="Setup steps">${SETUP_STEPS.map((step, index) => `<li data-n="${index + 1}"${index === 0 ? ' aria-current="step"' : ""}>${step}</li>`).join("")}</ol>
<p class="count">Step 1 of ${SETUP_STEPS.length}</p>
<div class="card">
<h1>Name your tenant</h1>
<p class="lead">${escapeHtml(email)} has no tenant yet. Name the tenant you and your team work in.</p>
<div class="problem" id="problem" role="alert" hidden><h2 id="problem-title" tabindex="-1"></h2><p id="problem-detail"></p><p id="problem-fix"></p><a id="problem-report" target="_blank" rel="noreferrer">Report an issue</a></div>
<form id="signup" novalidate>
<label for="name">Tenant name</label>
<input id="name" name="name" maxlength="100" autocomplete="organization" aria-describedby="name-hint" autofocus>
<p class="hint" id="name-hint">It shows in the tenant switcher and in invitations.</p>
<button type="submit">Create tenant</button>
</form>
</div>
</main>
<script>
const form = document.getElementById("signup");
const field = document.getElementById("name");
const hint = document.getElementById("name-hint");
const button = form.querySelector("button");
const HINT = hint.textContent;
const markField = (text) => {
  hint.textContent = text;
  hint.classList.add("error");
  field.setAttribute("aria-invalid", "true");
};
const clearField = () => {
  hint.textContent = HINT;
  hint.classList.remove("error");
  field.removeAttribute("aria-invalid");
};
const showProblem = (problem) => {
  document.getElementById("problem-title").textContent = problem.title;
  document.getElementById("problem-detail").textContent = problem.detail;
  document.getElementById("problem-fix").textContent = "Fix: " + problem.fix;
  const body = ["What failed: " + problem.title, "Detail: " + problem.detail, "Page: sign-up", "Time: " + new Date().toISOString()].join("\\n");
  document.getElementById("problem-report").href = ${JSON.stringify(REPORT_ISSUE_URL)} + "?" + new URLSearchParams({ title: "Sign-up: " + problem.title, body });
  document.getElementById("problem").hidden = false;
  if (/\\bname\\b/.test(problem.detail)) markField(problem.detail);
  document.getElementById("problem-title").focus();
};
const busy = (on) => {
  button.disabled = on;
  field.readOnly = on;
  button.textContent = on ? "Creating tenant..." : "Create tenant";
  button.setAttribute("aria-busy", String(on));
};
const unexpected = (status) => ({
  title: "The control plane answered something unexpected",
  detail: "Tenants_signUp answered " + status + " without a Problem body.",
  fix: "Create the tenant again. If it keeps failing, report it with the link.",
});
const silent = {
  title: "The control plane did not answer",
  detail: "Tenants_signUp got no answer within 15 seconds.",
  fix: "Check your connection, then create the tenant again.",
};
field.addEventListener("input", clearField);
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  if (field.value.trim() === "") {
    markField("Give the tenant a name.");
    field.focus();
    return;
  }
  busy(true);
  const answer = await fetch("/v1/tenants", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: field.value.trim() }),
    signal: AbortSignal.timeout(15000),
  }).then(
    async (response) => (response.ok ? null : await response.json().catch(() => unexpected(response.status))),
    () => silent,
  );
  if (answer === null) {
    location.reload();
    return;
  }
  busy(false);
  showProblem(answer);
});
</script>`,
  );

export interface TenantChoice {
  tenantId: string;
  name: string;
}

const tenantField = (tenants: TenantChoice[], name: string): string => {
  const [only, ...others] = tenants;
  if (only !== undefined && others.length === 0) {
    return `<input type="hidden" name="${name}" value="${escapeHtml(only.tenantId)}">`;
  }
  const options = tenants
    .map((tenant) => `<option value="${escapeHtml(tenant.tenantId)}">${escapeHtml(tenant.name)}</option>`)
    .join("");
  return `<p><label>Tenant <select name="${name}" required>${options}</select></label></p>`;
};

const tenantPhrase = (tenants: TenantChoice[]): string => {
  const [only, ...others] = tenants;
  return only !== undefined && others.length === 0 ? `of ${escapeHtml(only.name)}` : "in the tenant you choose below";
};

export const enterCodePage = (email: string): Response =>
  page(
    200,
    "Sign in a device",
    `<p>Signed in as ${escapeHtml(email)}. Enter the code your terminal shows.</p>
<form method="get" action="/device"><input name="code" autocomplete="off" required autofocus><button type="submit">Continue</button></form>`,
  );

export const confirmPage = (email: string, tenants: TenantChoice[], userCode: string, deviceName: string): Response =>
  page(
    200,
    "Sign in a device",
    `<p>The device <strong>${escapeHtml(deviceName)}</strong> asks to use tumpel as ${escapeHtml(email)} ${tenantPhrase(tenants)}.</p>
<p>Check that your terminal shows this code:</p><p><code>${escapeHtml(userCode)}</code></p>
<form id="decide">${tenantField(tenants, "tenantId")}<button type="submit" value="approve">Approve</button><button type="submit" value="deny">Deny</button></form>
<p id="result" role="alert"></p>
<script>${POST_JSON}
document.getElementById("decide").addEventListener("submit", async (event) => {
  event.preventDefault();
  const action = event.submitter.value;
  const decision = { userCode: ${JSON.stringify(userCode)} };
  const answer = await post("/v1/device/" + action, action === "approve" ? { ...decision, tenantId: new FormData(event.target).get("tenantId") } : decision);
  if (answer === null) return;
  event.target.remove();
  document.getElementById("result").textContent = action === "approve"
    ? "Approved " + answer.name + ". Return to your terminal."
    : "Denied. The device gets no access.";
});</script>`,
  );

export const grantPage = (
  email: string,
  tenants: TenantChoice[],
  clientName: string,
  callbackOrigin: string,
  requestId: string,
  csrf: string,
): Response =>
  page(
    200,
    "Connect an MCP client",
    `<p><strong>${escapeHtml(clientName)}</strong> at ${escapeHtml(callbackOrigin)} asks to use tumpel as ${escapeHtml(email)} ${tenantPhrase(tenants)}.</p>
<form method="post">${tenantField(tenants, "tenant")}<input type="hidden" name="request" value="${escapeHtml(requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<button type="submit" name="action" value="approve">Connect</button><button type="submit" name="action" value="deny">Cancel</button></form>`,
    { "set-cookie": `${CONSENT_CSRF_COOKIE}=${csrf}; Path=/; Max-Age=600; Secure; HttpOnly; SameSite=Strict` },
  );

export const readCookie = (header: string | null, name: string): string | null => {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
};

export const appSetupPage = (email: string, manifest: unknown, action: string, owner: string): Response =>
  page(
    200,
    "Create the GitHub App",
    `<p>Signed in as ${escapeHtml(email)}. This stage has no GitHub App yet. Creating it is a one-time step: GitHub shows the App this manifest describes, owned by ${escapeHtml(owner)}, and sends you back here once it exists.</p>
<p>It asks for read and write access to contents, pull requests, issues, checks, statuses, workflows and discussions, and read access to actions and metadata. It asks for no administration, members, organization or secrets access.</p>
<p>To create it under an organization instead, open this page with <code>?organization=&lt;login&gt;</code>.</p>
<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Create the GitHub App on GitHub</button></form>`,
  );

export const linkPage = (status: number, title: string, text: string, href: string, label: string): Response =>
  page(status, title, `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`);

export const acceptPage = (email: string, tenantName: string, role: string, token: string, next: string): Response =>
  page(
    200,
    "Join a tenant",
    `<p>Signed in as ${escapeHtml(email)}, invited to join ${escapeHtml(tenantName)} as ${escapeHtml(role)}.</p>
<form id="accept"><button type="submit">Join ${escapeHtml(tenantName)}</button></form>
<p id="result" role="alert"></p>
<script>${POST_JSON}
document.getElementById("accept").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await post("/v1/invitations/accept", { token: ${JSON.stringify(token)} })) location.assign(${JSON.stringify(next)});
});</script>`,
  );

export const connectAgainPage = (status: number, title: string, text: string, connectUrl: string): Response =>
  linkPage(status, title, text, connectUrl, "Connect from Tumpel");

export const installationTenantPage = (
  email: string,
  accountLogin: string,
  action: string,
  choice: string,
  tenants: { tenantId: string; name: string }[],
): Response =>
  page(
    200,
    "Connect GitHub",
    `<p>Signed in as ${escapeHtml(email)}. Connect the GitHub App installation on <strong>${escapeHtml(accountLogin)}</strong> only if you started this installation yourself; its repositories become available to every member of the tenant you choose.</p>
${tenants.map((tenant) => `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="choice" value="${escapeHtml(choice)}"><input type="hidden" name="tenant" value="${escapeHtml(tenant.tenantId)}"><button type="submit">Connect ${escapeHtml(accountLogin)} to ${escapeHtml(tenant.name)}</button></form>`).join("")}`,
  );
