# wise-mcp

An MCP server for the [Wise](https://wise.com) (formerly TransferWise) API. It lets Claude, ChatGPT or any MCP agent check your balances, look up exchange rates, price transfers, manage recipients, and create, fund or track transfers. It authenticates with your Wise personal API token.

Built against **Wise Platform API version `2026Q4`** (`https://api.wise.com/2026Q4`). It runs locally over **stdio** for Claude Desktop and Claude Code, and over **Streamable HTTP** for ChatGPT, claude.ai and other remote clients.

## Tools

| Access level | Tool | Wise endpoint |
|---|---|---|
| `read` | `wise_list_profiles` | `GET /profiles` |
| | `wise_get_balances` | `GET /profiles/{id}/balances` |
| | `wise_get_exchange_rate` | `GET /rates` (current, historic, history) |
| | `wise_list_currencies` | `GET /currencies` |
| | `wise_create_quote` / `wise_get_quote` | `POST/GET /profiles/{id}/quotes` (moves no money) |
| | `wise_list_recipients` / `wise_get_recipient` | `GET /accounts` |
| | `wise_get_recipient_requirements` | `GET /quotes/{id}/account-requirements` |
| | `wise_list_transfers` / `wise_get_transfer` | `GET /transfers` |
| | `wise_get_delivery_estimate` | `GET /delivery-estimates/{id}` |
| | `wise_list_activities` | `GET /profiles/{id}/activities` |
| | `wise_get_balance_statement` | `GET /profiles/{id}/balance-statements/{balanceId}/statement.json` |
| `write` | `wise_create_recipient` | `POST /accounts` |
| | `wise_create_transfer` | `POST /transfers` (a draft; no money moves yet) |
| | `wise_cancel_transfer` | `PUT /transfers/{id}/cancel` |
| `payments` | `wise_fund_transfer` | `POST /profiles/{id}/transfers/{id}/payments` (**sends money**) |

`WISE_ACCESS` picks the level, and each level includes the ones above it.

**Recommended: keep the default `read`.** It covers recording and bookkeeping (balances, activity feed, transfer history, statements and rates) and an agent can't create or send anything at that level. `write` and `payments` are there if you ever need them, but they aren't recommended for agents. For recording, `wise_list_activities` and `wise_list_transfers` work with any personal token. `wise_get_balance_statement` gives line-by-line transactions, but only for accounts in the countries listed below. Tools above your level aren't registered at all, so the agent never sees them. `wise_fund_transfer` and `wise_cancel_transfer` are marked `destructiveHint`, so Claude and ChatGPT ask you before calling them.

A typical send flow:

```
list_profiles → create_quote → list_recipients (or get_recipient_requirements → create_recipient)
→ create_transfer → [you confirm] → fund_transfer → get_transfer / get_delivery_estimate
```

## What a personal token can and can't do

Wise documents these limits ([Personal API tokens](https://docs.wise.com/guides/developer/auth-and-security/personal-api-token)):

- Personal tokens are issued for **business accounts** (Settings → Connect and manage apps → API tokens).
- **Funding transfers and balance statements** only work for accounts based in the **US, Canada, Australia, New Zealand, Singapore and Malaysia**. Anywhere else, create the transfer with `wise_create_transfer` and approve it in the Wise app.
- **UK/EEA profiles** need Strong Customer Authentication (SCA) on protected calls. This server handles it automatically if you give it a key (see below).
- Some endpoints in Wise's reference are marked "user token only" but work with personal tokens. If one comes back with 403, Wise doesn't allow it for your token type.

## Setup

Published on npm as [`@dishtaweera/wise-mcp`](https://www.npmjs.com/package/@dishtaweera/wise-mcp). Your MCP client runs it with `npx`, so there is nothing to install or clone:

```bash
npx -y @dishtaweera/wise-mcp
```

Requires Node 20+. Pass the variables below through your MCP client config. Try it against the **sandbox** first: create an account at [wise-sandbox.com](https://wise-sandbox.com), make an API token there, and leave `WISE_ENV=sandbox` (the default). Set `WISE_ENV=production` when you're ready.

| Variable | |
|---|---|
| `WISE_API_TOKEN` | **Required.** Your personal API token |
| `WISE_ENV` | `sandbox` (default) or `production` |
| `WISE_ACCESS` | `read` (default, recommended), `write` or `payments` (not recommended) |
| `WISE_PROFILE_ID` | Optional default profile, so tools don't need `profileId` |
| `WISE_PRIVATE_KEY_PATH` / `WISE_PRIVATE_KEY` | Optional RSA private key for SCA (a file path, or the inline PEM) |
| `MCP_AUTH_TOKEN` | HTTP mode only, **required** there: a shared secret of at least 32 characters |
| `PORT` | HTTP mode port (default 3000) |

### Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (on Windows, `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "wise": {
      "command": "npx",
      "args": ["-y", "@dishtaweera/wise-mcp"],
      "env": {
        "WISE_API_TOKEN": "your-token",
        "WISE_ENV": "sandbox",
        "WISE_ACCESS": "read"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add wise -e WISE_API_TOKEN=your-token -e WISE_ENV=sandbox -- npx -y @dishtaweera/wise-mcp
```

### ChatGPT desktop app (local)

The ChatGPT desktop app can run local stdio servers through its Codex settings. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.wise]
command = "npx"
args = ["-y", "@dishtaweera/wise-mcp"]

[mcp_servers.wise.env]
WISE_API_TOKEN = "your-token"
WISE_ENV = "sandbox"
WISE_ACCESS = "read"
```

### ChatGPT web (and claude.ai custom connectors)

These clients connect to a **remote HTTPS** URL, so run the server in HTTP mode:

```bash
export MCP_AUTH_TOKEN=$(openssl rand -hex 32)
WISE_API_TOKEN=your-token npx -y @dishtaweera/wise-mcp --http     # http://localhost:3000/mcp
```

Expose it over HTTPS. For a quick test, use a tunnel such as `cloudflared tunnel --url http://localhost:3000`. For anything lasting, deploy it to any Node host and set the environment variables there.

ChatGPT connectors support only OAuth or no auth; they can't send a custom header. So the server also accepts the secret as the last part of the URL path:

- **ChatGPT**: Settings → Apps & Connectors → Advanced → turn on **Developer mode**, then create a connector with URL `https://your-host/mcp/<MCP_AUTH_TOKEN>` and authentication set to **No authentication**.
- **claude.ai**: Settings → Connectors → Add custom connector, using the same URL.
- **Clients that can send headers**: use `https://your-host/mcp` with `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Treat that URL like a password: anyone who has it can use your Wise account at the access level you set. Use HTTPS only, and change `MCP_AUTH_TOKEN` if the URL leaks.

## SCA (UK/EEA accounts)

When Wise needs extra authentication, it answers a request with `403` and a one-time token in the `x-2fa-approval` header. The server signs that token with your private key (SHA256withRSA, base64) and resends the request with `x-2fa-approval` and `X-Signature` headers. To set it up:

```bash
openssl genrsa -out wise-private.pem 2048
openssl rsa -pubout -in wise-private.pem -out wise-public.pem
```

Upload `wise-public.pem` in Wise under Settings → API tokens → Manage public keys. Then set `WISE_PRIVATE_KEY_PATH=/path/to/wise-private.pem`. In the sandbox, SCA is off until you enable it on that same page.

## Development

```bash
git clone https://github.com/deepanaishtaweera/wise-mcp && cd wise-mcp
npm install
npm test          # builds, then runs node:test against a mocked Wise API
```

The code is in three files: `src/wise.ts` (HTTP client and SCA signing), `src/tools.ts` (tool definitions) and `src/index.ts` (config and the stdio/HTTP transports). Responses are passed through as Wise's raw JSON text. Wise IDs are int64, so this avoids any chance of rounding them.

### Releasing

npm won't accept the same version twice, so bump it before each publish. `npm publish` runs the tests first and asks for npm two-factor approval in the browser.

```bash
npm version patch   # or minor / major; also commits and tags
git push --follow-tags
npm publish
```

## References

- [Wise API reference (2026Q4)](https://docs.wise.com/api-reference) and its [OpenAPI spec](https://docs.wise.com/_bundle/api-reference/@latest/index.yaml)
- [Versioning](https://docs.wise.com/guides/developer/global-versioning)
- [Personal API tokens](https://docs.wise.com/guides/developer/auth-and-security/personal-api-token)
- [SCA over API](https://docs.wise.com/guides/developer/auth-and-security/sca-over-api) and [One Time Token](https://docs.wise.com/guides/developer/auth-and-security/one-time-token)
- [Fund a transfer](https://docs.wise.com/api-reference/transfer/transferfund)
- [Sandbox v2 migration](https://docs.wise.com/guides/developer/environments/sandbox-v2-migration)
- [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
