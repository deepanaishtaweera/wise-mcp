import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WiseClient } from "./wise.js";

export const ACCESS_LEVELS = ["read", "write", "payments"] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

const id = (what: string) => z.number().int().positive().describe(what);
const currency = (what: string) => z.string().length(3).toUpperCase().describe(`${what} (ISO 4217, e.g. EUR)`);
const profileId = id("Wise profile ID. Optional when WISE_PROFILE_ID is set; get it from wise_list_profiles.").optional();

export function registerTools(server: McpServer, wise: WiseClient, opts: { access: Access; defaultProfileId?: number }) {
  const pid = (p?: number) => {
    const v = p ?? opts.defaultProfileId;
    if (!v) throw new Error("profileId is required: call wise_list_profiles first, or set WISE_PROFILE_ID.");
    return v;
  };

  const tool = <S extends z.ZodRawShape>(
    level: Access,
    name: string,
    config: { title: string; description: string; inputSchema: S; readOnly?: boolean; destructive?: boolean },
    run: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
  ) => {
    if (ACCESS_LEVELS.indexOf(level) > ACCESS_LEVELS.indexOf(opts.access)) return;
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: {
          title: config.title,
          readOnlyHint: config.readOnly ?? false,
          destructiveHint: config.destructive ?? false,
          openWorldHint: true,
        },
      },
      // @ts-expect-error SDK's generic callback type doesn't narrow from our generic shape
      async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return { content: [{ type: "text" as const, text: (await run(args)) || "OK" }] };
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
        }
      },
    );
  };

  // ---------- read ----------

  tool("read", "wise_list_profiles", {
    title: "List profiles",
    description: "List the Wise profiles (personal and business) this token can access. Most other tools need a profile ID from here.",
    inputSchema: {},
    readOnly: true,
  }, () => wise.request("GET", "/profiles"));

  tool("read", "wise_get_balances", {
    title: "Get balances",
    description: "Get multi-currency balances for a profile: amount, reserved amount and balance ID per currency.",
    inputSchema: { profileId, types: z.string().default("STANDARD").describe("Comma-separated: STANDARD, SAVINGS") },
    readOnly: true,
  }, (a) => wise.request("GET", `/profiles/${pid(a.profileId)}/balances`, { query: { types: a.types } }));

  tool("read", "wise_get_exchange_rate", {
    title: "Get exchange rate",
    description: "Get the current mid-market rate for a currency pair, a historic rate at `time`, or a history between `from` and `to` grouped by `group`.",
    inputSchema: {
      source: currency("Source currency"),
      target: currency("Target currency"),
      time: z.string().optional().describe("ISO 8601 timestamp for a historic rate"),
      from: z.string().optional().describe("History start (ISO 8601 date or timestamp)"),
      to: z.string().optional().describe("History end (ISO 8601 date or timestamp)"),
      group: z.enum(["day", "hour", "minute"]).optional(),
    },
    readOnly: true,
  }, (a) => wise.request("GET", "/rates", { query: a }));

  tool("read", "wise_list_currencies", {
    title: "List currencies",
    description: "List all currencies Wise can send to.",
    inputSchema: {},
    readOnly: true,
  }, () => wise.request("GET", "/currencies"));

  tool("read", "wise_create_quote", {
    title: "Create quote",
    description:
      "Price a transfer: returns the rate, fees, delivery estimate and a quote ID (valid ~30 min) needed to create a transfer. " +
      "Moves no money, but needs a full-access token (read-only tokens get error.quote.mustBeAuthenticated); " +
      "use wise_get_exchange_rate for rates alone. Give exactly one of sourceAmount or targetAmount.",
    inputSchema: {
      profileId,
      sourceCurrency: currency("Currency you send"),
      targetCurrency: currency("Currency the recipient gets"),
      sourceAmount: z.number().positive().optional(),
      targetAmount: z.number().positive().optional(),
      targetAccount: id("Recipient ID, if already known (gives a more accurate fee)").optional(),
      preferredPayIn: z.string().default("BALANCE").describe("BALANCE to pay from your Wise balance, or BANK_TRANSFER"),
    },
  }, (a) => {
    if ((a.sourceAmount === undefined) === (a.targetAmount === undefined)) {
      throw new Error("Give exactly one of sourceAmount or targetAmount.");
    }
    const { profileId: p, ...body } = a;
    return wise.request("POST", `/profiles/${pid(p)}/quotes`, { body });
  });

  tool("read", "wise_get_quote", {
    title: "Get quote",
    description: "Fetch an existing quote by ID.",
    inputSchema: { profileId, quoteId: z.string().describe("Quote ID (UUID)") },
    readOnly: true,
  }, (a) => wise.request("GET", `/profiles/${pid(a.profileId)}/quotes/${encodeURIComponent(a.quoteId)}`));

  tool("read", "wise_list_recipients", {
    title: "List recipients",
    description: "List saved recipient accounts. Paginate with seekPosition from the previous response's seekPositionForNext.",
    inputSchema: {
      profileId,
      currency: currency("Filter by target currency").optional(),
      size: z.number().int().min(1).max(20).optional(),
      seekPosition: z.number().int().optional(),
    },
    readOnly: true,
  }, (a) => wise.request("GET", "/accounts", { query: { ...a, profileId: pid(a.profileId) } }));

  tool("read", "wise_get_recipient", {
    title: "Get recipient",
    description: "Fetch one recipient account by ID.",
    inputSchema: { recipientId: id("Recipient account ID") },
    readOnly: true,
  }, (a) => wise.request("GET", `/accounts/${a.recipientId}`));

  tool("read", "wise_get_recipient_requirements", {
    title: "Get recipient requirements",
    description:
      "For a quote, list which recipient account types exist for the route (e.g. iban, sort_code, aba) and the exact fields each needs. " +
      "Call this before wise_create_recipient.",
    inputSchema: { quoteId: z.string().describe("Quote ID from wise_create_quote") },
    readOnly: true,
  }, (a) => wise.request("GET", `/quotes/${encodeURIComponent(a.quoteId)}/account-requirements`));

  tool("read", "wise_list_transfers", {
    title: "List transfers",
    description:
      "List transfers for a profile, OLDEST first, optionally filtered by status, currency and creation date. " +
      "For recent transfers set createdDateStart rather than relying on order.",
    inputSchema: {
      profileId,
      status: z.string().optional().describe("Comma-separated, e.g. incoming_payment_waiting,processing,outgoing_payment_sent,cancelled"),
      sourceCurrency: currency("Source currency").optional(),
      targetCurrency: currency("Target currency").optional(),
      createdDateStart: z.string().optional().describe("ISO 8601 date, inclusive"),
      createdDateEnd: z.string().optional().describe("ISO 8601 date, inclusive"),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    },
    readOnly: true,
  }, ({ profileId: p, ...q }) => wise.request("GET", "/transfers", { query: { ...q, profile: pid(p) } }));

  tool("read", "wise_get_transfer", {
    title: "Get transfer",
    description: "Get a transfer's details and current status.",
    inputSchema: { transferId: id("Transfer ID") },
    readOnly: true,
  }, (a) => wise.request("GET", `/transfers/${a.transferId}`));

  tool("read", "wise_get_delivery_estimate", {
    title: "Get delivery estimate",
    description: "Get when a transfer is expected to arrive.",
    inputSchema: { transferId: id("Transfer ID"), timezone: z.string().optional().describe("e.g. Europe/London") },
    readOnly: true,
  }, (a) => wise.request("GET", `/delivery-estimates/${a.transferId}`, { query: { timezone: a.timezone } }));

  tool("read", "wise_list_activities", {
    title: "List activities",
    description: "List recent account activity (card spend, transfers, conversions, top-ups). Paginate with nextCursor from the previous response's cursor.",
    inputSchema: {
      profileId,
      status: z.enum(["REQUIRES_ATTENTION", "IN_PROGRESS", "UPCOMING", "COMPLETED", "CANCELLED"]).optional(),
      since: z.string().optional().describe("ISO 8601 timestamp"),
      until: z.string().optional().describe("ISO 8601 timestamp"),
      size: z.number().int().min(1).max(100).optional(),
      nextCursor: z.string().optional(),
    },
    readOnly: true,
  }, ({ profileId: p, ...q }) => wise.request("GET", `/profiles/${pid(p)}/activities`, { query: q }));

  tool("read", "wise_get_balance_statement", {
    title: "Get balance statement",
    description:
      "Get the transactions on one balance between two times. Needs SCA (WISE_PRIVATE_KEY_PATH) for UK/EEA profiles; " +
      "personal tokens only support this for US, CA, AU, NZ, SG and MY accounts.",
    inputSchema: {
      profileId,
      balanceId: id("Balance ID from wise_get_balances"),
      currency: currency("Balance currency"),
      intervalStart: z.string().describe("UTC ISO 8601, e.g. 2026-10-01T00:00:00.000Z"),
      intervalEnd: z.string().describe("UTC ISO 8601; max 469 days after start"),
      type: z.enum(["COMPACT", "FLAT"]).default("COMPACT"),
    },
    readOnly: true,
  }, ({ profileId: p, balanceId, ...q }) =>
    wise.request("GET", `/profiles/${pid(p)}/balance-statements/${balanceId}/statement.json`, { query: q }));

  // ---------- write: creates records, moves no money ----------

  tool("write", "wise_create_recipient", {
    title: "Create recipient",
    description:
      "Save a recipient bank account. Get `type` and the required `details` fields from wise_get_recipient_requirements first " +
      "(e.g. GBP sort_code: {legalType, sortCode, accountNumber}; EUR iban: {legalType, iban}).",
    inputSchema: {
      profileId,
      currency: currency("Recipient account currency"),
      type: z.string().describe("Account type from requirements, e.g. iban, sort_code, aba"),
      accountHolderName: z.string().min(1),
      ownedByCustomer: z.boolean().optional().describe("True if the account belongs to the profile owner"),
      details: z.record(z.string(), z.unknown()).describe("Route-specific fields from the requirements"),
    },
  }, ({ profileId: p, ...rest }) => wise.request("POST", "/accounts", { body: { ...rest, profile: pid(p) } }));

  tool("write", "wise_create_transfer", {
    title: "Create transfer (draft)",
    description:
      "Create a transfer from a quote to a recipient. This is a draft: no money leaves until it is funded " +
      "(wise_fund_transfer, or in the Wise app). One transfer per quote.",
    inputSchema: {
      quoteUuid: z.string().describe("Quote ID from wise_create_quote"),
      targetAccount: id("Recipient ID"),
      reference: z.string().max(100).optional().describe("Shown on the recipient's statement; max length varies by route"),
      details: z.record(z.string(), z.unknown()).optional().describe("Extra route-specific fields, e.g. transferPurpose, sourceOfFunds"),
      customerTransactionId: z.string().uuid().optional().describe("Idempotency key; generated if omitted"),
    },
  }, (a) =>
    wise.request("POST", "/transfers", {
      body: {
        targetAccount: a.targetAccount,
        quoteUuid: a.quoteUuid,
        customerTransactionId: a.customerTransactionId ?? randomUUID(),
        details: { ...a.details, ...(a.reference !== undefined && { reference: a.reference }) },
      },
    }));

  tool("write", "wise_cancel_transfer", {
    title: "Cancel transfer",
    description: "Cancel a transfer. Only works while it is still incoming_payment_waiting.",
    inputSchema: { transferId: id("Transfer ID") },
    destructive: true,
  }, (a) => wise.request("PUT", `/transfers/${a.transferId}/cancel`));

  // ---------- payments: moves real money ----------

  tool("payments", "wise_fund_transfer", {
    title: "Fund transfer (sends money)",
    description:
      "Pay a created transfer from your Wise balance. THIS SENDS REAL MONEY and cannot be undone once processed. " +
      "Only call after the user has explicitly confirmed the amount and recipient. " +
      "Personal tokens support this only for US, CA, AU, NZ, SG and MY accounts; UK/EEA needs SCA (WISE_PRIVATE_KEY_PATH).",
    inputSchema: {
      profileId,
      transferId: id("Transfer ID from wise_create_transfer"),
      balanceId: id("Balance to debit; defaults to the balance in the transfer's source currency").optional(),
    },
    destructive: true,
  }, (a) =>
    wise.request("POST", `/profiles/${pid(a.profileId)}/transfers/${a.transferId}/payments`, {
      body: { type: "BALANCE", ...(a.balanceId && { balanceId: a.balanceId }) },
    }));
}
