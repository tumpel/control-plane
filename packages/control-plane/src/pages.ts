export const CONSENT_CSRF_COOKIE = "__Host-tumpel_connect";

const escapeHtml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const page = (status: number, title: string, body: string, headers: Record<string, string> = {}): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} · tumpel</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem;margin:.25rem 0}code{font-size:1.4rem}</style></head>
<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
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
  const answer = await response.json();
  document.getElementById("result").textContent = response.ok ? "" : answer.detail + ". " + answer.fix;
  return response.ok ? answer : null;
}`;

export const signUpPage = (email: string): Response =>
  page(
    200,
    "Create your tenant",
    `<p>Signed in as ${escapeHtml(email)}, which owns no tenant yet.</p>
<form id="signup"><input name="name" placeholder="Tenant name" maxlength="100" required autofocus><button type="submit">Create tenant</button></form>
<p id="result" role="alert"></p>
<script>${POST_JSON}
document.getElementById("signup").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (await post("/v1/tenants", { name: new FormData(event.target).get("name") })) location.reload();
});</script>`,
  );

export const approvePage = (email: string, tenantName: string, code: string): Response =>
  page(
    200,
    "Sign in a device",
    `<p>Signed in as ${escapeHtml(email)} of ${escapeHtml(tenantName)}. Enter the code your terminal shows.</p>
<form id="approve"><input name="userCode" value="${escapeHtml(code)}" autocomplete="off" required autofocus><button type="submit">Approve</button></form>
<p id="result" role="alert"></p>
<script>${POST_JSON}
document.getElementById("approve").addEventListener("submit", async (event) => {
  event.preventDefault();
  const device = await post("/v1/device/approve", { userCode: new FormData(event.target).get("userCode") });
  if (device) document.getElementById("result").textContent = "Approved " + device.name + ". Return to your terminal.";
});</script>`,
  );

export const grantPage = (
  email: string,
  clientName: string,
  callbackOrigin: string,
  requestId: string,
  csrf: string,
): Response =>
  page(
    200,
    "Connect an MCP client",
    `<p><strong>${escapeHtml(clientName)}</strong> at ${escapeHtml(callbackOrigin)} asks to use tumpel as ${escapeHtml(email)}.</p>
<form method="post"><input type="hidden" name="request" value="${escapeHtml(requestId)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
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
