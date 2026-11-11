// A thin wrapper over the real Neon MCP Server, called the same way an agent
// calls it: the MCP SDK StreamableHTTP transport, the Neon API key as the
// bearer token, and the read-only / role-pin controls set on the URL.
//
// readonly=true  -> each run_sql runs inside a READ ONLY transaction.
// roleName=<r>   -> every SQL tool logs in as role <r>, with no fallback.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { need } from "./neon.mjs";

const DEFAULT_URL = process.env.NEON_MCP_URL || "https://mcp.neon.tech/mcp";

// Parse "SQLSTATE: 25006" out of the text the server returns on an error.
export function parseSqlState(text) {
  const m = /SQLSTATE:\s*([0-9A-Z]{5})/.exec(text || "");
  return m ? m[1] : undefined;
}

export async function openMcp({ readonly = false, roleName } = {}) {
  const url = new URL(DEFAULT_URL);
  if (readonly) url.searchParams.set("readonly", "true");
  if (roleName) url.searchParams.set("roleName", roleName);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${need("NEON_API_KEY")}` } },
  });
  const client = new Client({ name: "neon-read-only-agent", version: "1.0.0" });
  await client.connect(transport);

  const listToolNames = async () => (await client.listTools()).tools.map((t) => t.name);

  // Run one statement through run_sql. Returns a uniform outcome.
  // The SDK's default request timeout is 60 s; a heavy read on a small replica
  // can take longer, so the caller can raise it.
  const runSql = async ({ sql, projectId, branchId, database = "neondb", computeId, timeoutMs = 300_000 }) => {
    const args = { sql, project_id: projectId, database_name: database };
    if (branchId) args.branch_id = branchId;
    if (computeId) args.compute_id = computeId;
    try {
      const r = await client.callTool({ name: "run_sql", arguments: args }, undefined, { timeout: timeoutMs });
      const text = (r.content || []).map((c) => c.text || "").join("\n");
      if (r.isError) return { ok: false, sqlstate: parseSqlState(text), error: text.slice(0, 500) };
      return { ok: true, text };
    } catch (e) {
      // A tool that is not offered in this mode (for example run_sql_transaction
      // under readonly) throws here rather than returning isError.
      return { ok: false, sqlstate: undefined, error: String(e).slice(0, 500), threw: true };
    }
  };

  return { client, transport, listToolNames, runSql, close: () => transport.close() };
}
