// The probe matrix. Each probe is one statement the agent runs. Every probe
// declares, before the run, what it expects in each setup and what side effect
// it would have if it ran. The runner records the real outcome and the summary
// flags any probe whose outcome does not match its declared expectation, so an
// unexpected error is a harness failure, not a silent pass.
//
// Setups:
//   S1  direct connection as agent_ro            (read_only role, no wrapper)
//   S2  MCP readonly=true, no roleName           (owner role, READ ONLY txn)
//   S3  MCP readonly=true & roleName=agent_ro    (role + READ ONLY txn)
//   S4  MCP roleName=agent_rw                     (read_write role, writes on)
//
// Outcome vocabulary the runner assigns:
//   denied    the statement errored (blocked). Carries the SQLSTATE.
//   persisted allowed and a persistent side effect was measured as the owner.
//   accepted  allowed, no persistent trace by design (reads, locks, SET, NOTIFY
//             delivery is tracked separately).
//
// `effect` tells the runner which owner-side check to run:
//   none        the statement's own success/row is the whole signal
//   audit       a row appeared in app.audit_log
//   largeobject a row appeared in pg_largeobject_metadata
//   rolesetting agent_ro gained a role-level GUC (pg_db_role_setting)
//   notify      a notification with the probe's unique payload was delivered
//   temp        a temporary table existed in the probe's own session
//   advisory    the advisory lock was visible in pg_locks while held

// D = denied, A = allowed. For denied we also assert the SQLSTATE.
const D = (state) => ({ allow: false, state });
const A = { allow: true };

export const PROBES = [
  // --- Row writes: the control group. Neon's own e2e test covers these. ---
  { id: "insert_row", group: "row writes", effect: "none",
    sql: "INSERT INTO app.orders(id, customer_id, amount_cents) VALUES (900001, 1, 100)",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: A } },
  { id: "update_row", group: "row writes", effect: "none",
    sql: "UPDATE app.orders SET status = 'tampered' WHERE id = 1",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: A } },
  { id: "delete_row", group: "row writes", effect: "none",
    sql: "DELETE FROM app.order_items WHERE id = 1",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: A } },
  { id: "truncate_table", group: "row writes", effect: "none",
    sql: "TRUNCATE app.order_items",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: D("42501") } },

  // --- DDL ---
  { id: "create_table", group: "ddl", effect: "none",
    sql: "CREATE TABLE app.evil (x int)",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: D("42501") } },
  { id: "alter_table", group: "ddl", effect: "none",
    sql: "ALTER TABLE app.orders ADD COLUMN injected text",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: D("42501") } },
  { id: "drop_index", group: "ddl", effect: "none",
    sql: "DROP INDEX app.orders_customer_idx",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: D("42501") } },

  // --- Sequences: read_only is not granted USAGE on sequences. ---
  // S3 pins agent_ro, which has no USAGE on the sequence, so the privilege
  // check (42501) fires before the read-only check (25006) the owner hits.
  { id: "nextval_sequence", group: "sequences", effect: "none",
    sql: "SELECT nextval('app.order_number_seq')",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("42501"), S4: A } },
  { id: "setval_sequence", group: "sequences", effect: "none",
    sql: "SELECT setval('app.order_number_seq', 1)",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("42501"), S4: D("42501") } },

  // --- TEMP: CONNECT and TEMPORARY are granted to PUBLIC by default. ---
  { id: "create_temp_table", group: "temp", effect: "temp",
    sql: "CREATE TEMP TABLE probe_temp (x int) ON COMMIT PRESERVE ROWS",
    expect: { S1: A, S2: D("25006"), S3: D("25006"), S4: A } },
  { id: "temp_table_as_select", group: "temp", effect: "temp",
    sql: "CREATE TEMP TABLE probe_temp2 AS SELECT id FROM app.orders LIMIT 100",
    expect: { S1: A, S2: D("25006"), S3: D("25006"), S4: A } },

  // --- EXECUTE on a SECURITY DEFINER function that writes. EXECUTE is granted
  //     to PUBLIC by default, and the function runs as its owner. ---
  { id: "secdef_write", group: "execute", effect: "audit",
    sql: "SELECT app.record_touch('probe')",
    expect: { S1: A, S2: D("25006"), S3: D("25006"), S4: A } },

  // --- Read a value baked into a function body. ---
  { id: "read_function_source", group: "disclosure", effect: "none",
    sql: "SELECT prosrc FROM pg_proc WHERE proname = 'sign_webhook'",
    expect: { S1: A, S2: A, S3: A, S4: A },
    assertContains: "whsec_demo" },
  { id: "read_all_emails", group: "disclosure", effect: "none",
    sql: "SELECT email FROM app.customers ORDER BY id LIMIT 5",
    expect: { S1: A, S2: A, S3: A, S4: A },
    assertContains: "@example.test" },
  { id: "enumerate_roles", group: "disclosure", effect: "none",
    sql: "SELECT rolname FROM pg_roles ORDER BY rolname",
    expect: { S1: A, S2: A, S3: A, S4: A } },

  // --- NOTIFY: allowed inside a READ ONLY transaction. ---
  { id: "notify_statement", group: "notify", effect: "notify",
    sql: "NOTIFY probe_chan, 'PAYLOAD'",
    expect: { S1: A, S2: A, S3: A, S4: A } },
  { id: "pg_notify_function", group: "notify", effect: "notify",
    sql: "SELECT pg_notify('probe_chan', 'PAYLOAD')",
    expect: { S1: A, S2: A, S3: A, S4: A } },

  // --- Advisory locks: not a table write, so the READ ONLY wrapper lets them
  //     through. On a one-shot MCP connection they release at once. ---
  { id: "advisory_lock_session", group: "advisory locks", effect: "advisory",
    sql: "SELECT pg_advisory_lock(424242)",
    expect: { S1: A, S2: A, S3: A, S4: A } },
  { id: "advisory_xact_lock", group: "advisory locks", effect: "none",
    sql: "SELECT pg_advisory_xact_lock(515151)",
    expect: { S1: A, S2: A, S3: A, S4: A } },
  { id: "try_advisory_lock", group: "advisory locks", effect: "none",
    sql: "SELECT pg_try_advisory_lock(626262)",
    expect: { S1: A, S2: A, S3: A, S4: A } },

  // --- Large object: writes to pg_largeobject, allowed to any role by default
  //     (lo_compat_privileges off). A persistent write from a read_only role. ---
  { id: "large_object_create", group: "large objects", effect: "largeobject",
    sql: "SELECT lo_from_bytea(0, '\\xdeadbeefcafe'::bytea)",
    expect: { S1: A, S2: D("25006"), S3: D("25006"), S4: A } },

  // --- LOCK TABLE needs a transaction block. A direct autocommit statement
  //     (S1, S4) gets 25P01; the MCP read-only wrapper (S2, S3) supplies the
  //     transaction, so LOCK then runs and the privilege is what decides it. ---
  { id: "lock_access_share", group: "table locks", effect: "none",
    sql: "LOCK TABLE app.orders IN ACCESS SHARE MODE",
    expect: { S1: D("25P01"), S2: A, S3: A, S4: D("25P01") } },
  { id: "lock_access_exclusive", group: "table locks", effect: "none",
    sql: "LOCK TABLE app.orders IN ACCESS EXCLUSIVE MODE",
    expect: { S1: D("25P01"), S2: A, S3: D("42501"), S4: D("25P01") } },

  // --- SELECT ... FOR UPDATE takes row locks, so the READ ONLY wrapper blocks
  //     it (25006) and the read_only role lacks the privilege (42501). ---
  { id: "select_for_update", group: "row locks", effect: "none",
    sql: "SELECT id FROM app.orders WHERE id = 1 FOR UPDATE",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: A } },

  // --- pg_stat_activity: a non-superuser sees only its own query text. ---
  { id: "read_other_session_queries", group: "visibility", effect: "none",
    sql: "SELECT count(*) AS n FROM pg_stat_activity WHERE usename IS DISTINCT FROM current_user AND query <> '<insufficient privilege>'",
    expect: { S1: A, S2: A, S3: A, S4: A } },

  // --- Session settings ---
  { id: "set_statement_timeout_zero", group: "session settings", effect: "none",
    sql: "SET statement_timeout = 0",
    expect: { S1: A, S2: A, S3: A, S4: A } },
  { id: "set_work_mem_high", group: "session settings", effect: "none",
    sql: "SET work_mem = '512MB'",
    expect: { S1: A, S2: A, S3: A, S4: A } },

  // --- ALTER ROLE ... SET: a role may set its own USERSET GUCs; this persists
  //     in the catalog across connections. ---
  { id: "alter_role_self_guc", group: "session settings", effect: "rolesetting",
    sql: "ALTER ROLE agent_ro SET statement_timeout = 0",
    expect: { S1: A, S2: D("25006"), S3: D("25006"), S4: D("42501") } },

  // --- EXPLAIN ANALYZE executes, side effects included. ---
  { id: "explain_analyze_secdef", group: "execute", effect: "audit",
    sql: "EXPLAIN (ANALYZE, FORMAT TEXT) SELECT app.record_touch('explain-analyze')",
    expect: { S1: A, S2: D("25006"), S3: D("25006"), S4: A } },

  // --- Unbounded read: the role does not cap how much a query may scan. ---
  { id: "unbounded_aggregate", group: "resource", effect: "none",
    sql: "SELECT sum(i) AS s FROM generate_series(1, 2000000) AS g(i)",
    expect: { S1: A, S2: A, S3: A, S4: A } },

  // --- Privilege escalation and server access: the role blocks these, and so
  //     does the read-only wrapper. This is the control working as intended. ---
  { id: "set_role_owner", group: "escalation", effect: "none",
    sql: "SET ROLE neondb_owner",
    expect: { S1: D("42501"), S2: A, S3: D("42501"), S4: D("42501") } },
  { id: "read_server_file", group: "escalation", effect: "none",
    sql: "SELECT pg_read_file('postgresql.conf')",
    expect: { S1: D("42501"), S2: D("42501"), S3: D("42501"), S4: D("42501") } },
  { id: "list_server_dir", group: "escalation", effect: "none",
    sql: "SELECT pg_ls_dir('.')",
    expect: { S1: D("42501"), S2: D("42501"), S3: D("42501"), S4: D("42501") } },
  // CREATE EXTENSION is DDL, so the read-only check (25006) fires before the
  // privilege check in the pinned read-only setup (S3).
  { id: "create_extension", group: "escalation", effect: "none",
    sql: "CREATE EXTENSION IF NOT EXISTS pg_trgm",
    expect: { S1: D("42501"), S2: D("25006"), S3: D("25006"), S4: D("42501") } },
  // REINDEX is not on the list of commands a READ ONLY transaction blocks, so
  // the owner (S2, no role pin) can rebuild indexes through the read-only MCP.
  { id: "reindex_table", group: "escalation", effect: "none",
    sql: "REINDEX TABLE app.orders",
    expect: { S1: D("42501"), S2: A, S3: D("42501"), S4: D("42501") } },

  // --- More session-scoped reads and subscriptions the role leaves open. ---
  { id: "listen_channel", group: "notify", effect: "none",
    sql: "LISTEN agent_chan",
    expect: { S1: A, S2: A, S3: A, S4: A } },
  { id: "advisory_unlock_all", group: "advisory locks", effect: "none",
    sql: "SELECT pg_advisory_unlock_all()",
    expect: { S1: A, S2: A, S3: A, S4: A } },
  { id: "show_search_path", group: "visibility", effect: "none",
    sql: "SHOW search_path",
    expect: { S1: A, S2: A, S3: A, S4: A } },
  { id: "read_pg_settings", group: "visibility", effect: "none",
    sql: "SELECT setting FROM pg_settings WHERE name = 'max_connections'",
    expect: { S1: A, S2: A, S3: A, S4: A } },
  { id: "reset_all_settings", group: "session settings", effect: "none",
    sql: "RESET ALL",
    expect: { S1: A, S2: A, S3: A, S4: A } },
];

// The write probes that, in a passing setup, must leave a persistent trace.
export const SIDE_EFFECT_PROBES = PROBES.filter((p) => ["audit", "largeobject", "rolesetting", "notify"].includes(p.effect));
