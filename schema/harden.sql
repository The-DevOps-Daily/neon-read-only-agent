-- Hardening the read_only role and the database defaults, run as the owner.
-- Each statement closes one gap the probe matrix found. The comments say what
-- it changes and what it does NOT change, because some leftovers have no clean
-- role-level fix and are closed only by the MCP read-only wrapper.

-- 1. TEMP tables. CONNECT and TEMPORARY are granted to PUBLIC by default, so a
--    read_only role can still create temp tables. Revoke it, then grant it back
--    only to the roles that run the app.
REVOKE TEMPORARY ON DATABASE neondb FROM PUBLIC;
GRANT TEMPORARY ON DATABASE neondb TO neondb_owner, agent_rw;

-- 2. EXECUTE on functions. EXECUTE is granted to PUBLIC by default, so a
--    read_only role can call a SECURITY DEFINER function that writes. Revoke it
--    for the app schema, and for functions created there later.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_touch(text) TO neondb_owner, agent_rw;

-- 3. A connection cap, so one agent cannot open hundreds of sessions.
ALTER ROLE agent_ro CONNECTION LIMIT 5;

-- 4. Role-level safety timeouts. These are DEFAULTS: the session can still raise
--    statement_timeout to 0 (SET is a USERSET change), so they bound the common
--    case, not a determined caller. A hard cap belongs at the pooler or a
--    dedicated capped read replica.
ALTER ROLE agent_ro SET statement_timeout = '30s';
ALTER ROLE agent_ro SET lock_timeout = '2s';
ALTER ROLE agent_ro SET idle_in_transaction_session_timeout = '15s';

-- NOT fixed by this file, on purpose:
--  * NOTIFY and advisory locks are not privilege-controlled in Postgres.
--  * lo_from_bytea (large object writes) has no GRANT to revoke before the
--    lo_compat_privileges era; a direct read_only connection can still write
--    one. The read-only MCP wrapper (readonly=true) blocks it.
--  * pg_proc.prosrc stays world-readable, so a value baked into a function body
--    is still readable. The fix is not to store secrets in function bodies.
-- These are why a direct read_only connection string is weaker than the same
-- role reached only through the read-only MCP server.
