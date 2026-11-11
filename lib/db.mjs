import pg from "pg";

// node-postgres treats sslmode=require as verify-full anyway; say so, and drop
// channel_binding, which the driver does not read from the string.
export function clientConfig(uri) {
  const url = new URL(uri);
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.delete("channel_binding");
  return { connectionString: url.toString(), connectionTimeoutMillis: 60_000, application_name: "neon-anonymized-branches" };
}

export async function connect(uri) {
  for (let attempt = 1; ; attempt++) {
    const c = new pg.Client(clientConfig(uri));
    try {
      await c.connect();
      return c;
    } catch (e) {
      await c.end().catch(() => {});
      // A compute that is starting or a branch that is still masking refuses
      // connections for a while.
      if (attempt >= 8) throw e;
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

export async function withClient(uri, fn) {
  const c = await connect(uri);
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

export const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;
