import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWiseClient } from "../dist/wise.js";
import { registerTools } from "../dist/tools.js";

const calls = [];
function mockFetch(responder) {
  calls.length = 0;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), ...init });
    return responder(calls.length, init);
  };
}

test("signs the SCA one-time token and retries", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  mockFetch((n) =>
    n === 1
      ? new Response("", { status: 403, headers: { "x-2fa-approval": "ott-123", "x-2fa-approval-result": "REJECTED" } })
      : new Response('{"id":9007199254740993}', { status: 200 }),
  );
  const wise = createWiseClient({ token: "t", env: "sandbox", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) });

  const out = await wise.request("GET", "/profiles/1/balance-statements/2/statement.json", { query: { currency: "USD", x: undefined } });

  assert.equal(out, '{"id":9007199254740993}', "body passed through verbatim, no int64 rounding");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.wise-sandbox.com/2026Q4/profiles/1/balance-statements/2/statement.json?currency=USD");
  const h = calls[1].headers;
  assert.equal(h["x-2fa-approval"], "ott-123");
  assert.equal(h.Authorization, "Bearer t");
  assert.ok(createVerify("SHA256").update("ott-123").verify(publicKey, h["X-Signature"], "base64"), "valid SHA256withRSA signature");
});

test("explains SCA when no key is configured, and surfaces API errors with trace id", async () => {
  mockFetch(() => new Response("", { status: 403, headers: { "x-2fa-approval": "o", "x-2fa-approval-result": "REJECTED" } }));
  const wise = createWiseClient({ token: "t", env: "production" });
  await assert.rejects(wise.request("POST", "/x"), /WISE_PRIVATE_KEY_PATH/);

  mockFetch(() => new Response('{"errors":[{"code":"balance.insufficient-funds"}]}', { status: 422, headers: { "x-trace-id": "tr1" } }));
  await assert.rejects(wise.request("POST", "/x", { body: {} }), /HTTP 422 \(x-trace-id tr1\).*insufficient-funds/);
  assert.equal(calls[0].url, "https://api.wise.com/2026Q4/x");
});

async function connect(access, defaultProfileId) {
  const server = new McpServer({ name: "t", version: "0" });
  registerTools(server, createWiseClient({ token: "t", env: "sandbox" }), { access, defaultProfileId });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("access levels gate which tools exist", async () => {
  const names = async (lvl) => (await (await connect(lvl)).listTools()).tools.map((t) => t.name);
  const read = await names("read");
  const write = await names("write");
  const payments = await names("payments");
  assert.ok(read.includes("wise_get_balances") && !read.includes("wise_create_transfer") && !read.includes("wise_fund_transfer"));
  assert.ok(write.includes("wise_create_transfer") && !write.includes("wise_fund_transfer"));
  assert.ok(payments.includes("wise_fund_transfer"));
  const fund = (await (await connect("payments")).listTools()).tools.find((t) => t.name === "wise_fund_transfer");
  assert.equal(fund.annotations.destructiveHint, true);
});

test("tool calls hit the right endpoint and validate input", async () => {
  mockFetch(() => new Response('{"id":"q1"}', { status: 200 }));
  const client = await connect("payments", 42);

  const bad = await client.callTool({ name: "wise_create_quote", arguments: { sourceCurrency: "usd", targetCurrency: "EUR", sourceAmount: 1, targetAmount: 2 } });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 0);

  const ok = await client.callTool({ name: "wise_create_quote", arguments: { sourceCurrency: "usd", targetCurrency: "EUR", sourceAmount: 100 } });
  assert.equal(ok.content[0].text, '{"id":"q1"}');
  assert.equal(calls[0].url, "https://api.wise-sandbox.com/2026Q4/profiles/42/quotes");
  assert.deepEqual(JSON.parse(calls[0].body), { sourceCurrency: "USD", targetCurrency: "EUR", sourceAmount: 100, preferredPayIn: "BALANCE" });

  await client.callTool({ name: "wise_create_transfer", arguments: { quoteUuid: "q1", targetAccount: 7, reference: "Invoice 9" } });
  const t = JSON.parse(calls[1].body);
  assert.equal(t.details.reference, "Invoice 9");
  assert.match(t.customerTransactionId, /^[0-9a-f-]{36}$/);

  await client.callTool({ name: "wise_fund_transfer", arguments: { transferId: 5 } });
  assert.equal(calls[2].url, "https://api.wise-sandbox.com/2026Q4/profiles/42/transfers/5/payments");
  assert.deepEqual(JSON.parse(calls[2].body), { type: "BALANCE" });
});
