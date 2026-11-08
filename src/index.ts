#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ACCESS_LEVELS, registerTools, type Access } from "./tools.js";
import { createWiseClient, type WiseEnv } from "./wise.js";

const env = process.env;
const fail = (msg: string): never => {
  console.error(`wise-mcp: ${msg}`);
  process.exit(1);
};

const token = env.WISE_API_TOKEN ?? fail("WISE_API_TOKEN is required (Wise > Settings > API tokens).");
const wiseEnv = (env.WISE_ENV ?? "sandbox") as WiseEnv;
if (wiseEnv !== "sandbox" && wiseEnv !== "production") fail("WISE_ENV must be sandbox or production.");
const access = (env.WISE_ACCESS ?? "read") as Access;
if (!ACCESS_LEVELS.includes(access)) fail(`WISE_ACCESS must be one of ${ACCESS_LEVELS.join(", ")}.`);
const defaultProfileId = env.WISE_PROFILE_ID ? Number(env.WISE_PROFILE_ID) : undefined;
const privateKey = env.WISE_PRIVATE_KEY ?? (env.WISE_PRIVATE_KEY_PATH && readFileSync(env.WISE_PRIVATE_KEY_PATH, "utf8"));

const wise = createWiseClient({ token, env: wiseEnv, privateKey: privateKey || undefined });

function buildServer() {
  const server = new McpServer(
    { name: "wise-mcp", version: "1.0.0" },
    {
      instructions:
        `Wise (${wiseEnv}) banking tools, access level "${access}". ` +
        "Typical send flow: wise_list_profiles -> wise_create_quote -> wise_list_recipients or " +
        "wise_get_recipient_requirements + wise_create_recipient -> wise_create_transfer -> wise_fund_transfer. " +
        "Always show the user the quote (amounts, fee, rate, recipient) and get explicit confirmation before funding a transfer.",
    },
  );
  registerTools(server, wise, { access, defaultProfileId });
  return server;
}

if (process.argv.includes("--http") || env.MCP_TRANSPORT === "http") {
  // Exposes a bank account to the network, so refuse to run without a shared secret.
  const secret = env.MCP_AUTH_TOKEN ?? "";
  if (secret.length < 32) fail("HTTP mode needs MCP_AUTH_TOKEN of at least 32 chars (e.g. `openssl rand -hex 32`).");
  const port = Number(env.PORT ?? 3000);
  const same = (a: string) => a.length === secret.length && timingSafeEqual(Buffer.from(a), Buffer.from(secret));

  createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const bearer = req.headers.authorization?.replace(/^Bearer /i, "") ?? "";
    // ChatGPT connectors can't send custom headers, so the secret may also be the last path segment: /mcp/<secret>
    const authed = (path === "/mcp" && same(bearer)) || (path.startsWith("/mcp/") && same(path.slice(5)));
    if (!authed) {
      res.writeHead(path === "/mcp" || path.startsWith("/mcp/") ? 401 : 404).end();
      return;
    }
    // Stateless: a fresh server per request keeps horizontal scaling and restarts trivial.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  }).listen(port, () => console.error(`wise-mcp (${wiseEnv}, ${access}) listening on http://localhost:${port}/mcp`));
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error(`wise-mcp (${wiseEnv}, ${access}) running on stdio`);
}
