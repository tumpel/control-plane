<p align="center"><img src="doc/assets/mascot.svg" alt="The tumpel salamander" width="160"></p>

# tumpel control plane

Tumpel runs coding harnesses on any hardware and drives them over MCP. This repository holds the control plane: a Cloudflare Worker (`packages/control-plane`) that keeps tenants, hosts and sessions, with one SQLite database per tenant, and the Worker that serves the dashboard (`packages/dashboard-site`). Hosts run [tumpel/supervisor](https://github.com/tumpel/supervisor), clients use [tumpel/cli](https://github.com/tumpel/cli), the API is defined in [tumpel/protocol](https://github.com/tumpel/protocol), and the Cloudflare resources live in [tumpel/infra](https://github.com/tumpel/infra).
