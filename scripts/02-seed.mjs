// Stage 2: apply the schema and seed fake data as the owner (direct, unpooled).
import { readFileSync } from "node:fs";
import { loadEnv, connectionUri } from "../lib/neon.mjs";
import { withClient } from "../lib/db.mjs";
import { readState, ROOT } from "../lib/record.mjs";
import { customers, orders } from "../lib/fake.mjs";
import { join } from "node:path";

loadEnv();
const state = readState();
const orderCount = Number(process.env.SEED_ORDERS || 5000);
const customerCount = Math.max(50, Math.floor(orderCount / 10));

const uri = await connectionUri(state.projectId, { branchId: state.branchId, pooled: false, role: state.ownerRole, database: state.database });

await withClient(uri, async (c) => {
  console.log("applying schema...");
  // Idempotent: a re-run rebuilds the app schema from scratch.
  await c.query("DROP SCHEMA IF EXISTS app CASCADE");
  await c.query(readFileSync(join(ROOT, "schema", "seed.sql"), "utf8"));

  console.log(`seeding ${customerCount} customers...`);
  const cvals = [];
  const cargs = [];
  let i = 0;
  for (const cu of customers(customerCount)) {
    cvals.push(`($${++i}, $${++i}, $${++i})`);
    cargs.push(cu.id, cu.email, cu.display_name);
    if (cvals.length >= 500) {
      await c.query(`INSERT INTO app.customers(id, email, display_name) VALUES ${cvals.join(",")}`, cargs);
      cvals.length = 0; cargs.length = 0; i = 0;
    }
  }
  if (cvals.length) await c.query(`INSERT INTO app.customers(id, email, display_name) VALUES ${cvals.join(",")}`, cargs);

  console.log(`seeding ${orderCount} orders with items...`);
  let ovals = [], oargs = [], oi = 0;
  let ivals = [], iargs = [], ii = 0;
  const flushOrders = async () => { if (ovals.length) { await c.query(`INSERT INTO app.orders(id, customer_id, status, amount_cents) VALUES ${ovals.join(",")}`, oargs); ovals = []; oargs = []; oi = 0; } };
  const flushItems = async () => { if (ivals.length) { await c.query(`INSERT INTO app.order_items(id, order_id, sku, qty, unit_cents) VALUES ${ivals.join(",")}`, iargs); ivals = []; iargs = []; ii = 0; } };
  for (const o of orders(orderCount, customerCount)) {
    ovals.push(`($${++oi}, $${++oi}, $${++oi}, $${++oi})`);
    oargs.push(o.id, o.customer_id, o.status, o.amount_cents);
    for (const it of o.items) {
      ivals.push(`($${++ii}, $${++ii}, $${++ii}, $${++ii}, $${++ii})`);
      iargs.push(it.id, it.order_id, it.sku, it.qty, it.unit_cents);
    }
    // Orders must land before their items (FK), so flush orders first.
    if (ovals.length >= 400) { await flushOrders(); await flushItems(); }
  }
  await flushOrders();
  await flushItems();

  // Advance the sequence as the app would, and keep order_number populated.
  await c.query("UPDATE app.orders SET order_number = nextval('app.order_number_seq') WHERE order_number IS NULL");

  const counts = await c.query(`SELECT
    (SELECT count(*) FROM app.customers) AS customers,
    (SELECT count(*) FROM app.orders) AS orders,
    (SELECT count(*) FROM app.order_items) AS items,
    (SELECT count(*) FROM app.audit_log) AS audit`);
  console.log("seeded:", counts.rows[0]);
});

console.log("\nseed done. next: npm run roles");
