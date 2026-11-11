-- A small fake SaaS orders database. All data is generated and seeded; no real
-- people. Owned by the branch owner role (neondb_owner). The read_only and
-- read_write roles are created later, by the Neon CLI, so their grants are
-- exactly what Neon issues.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.customers (
  id            bigint PRIMARY KEY,
  email         text NOT NULL,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE app.order_number_seq START 100000;

CREATE TABLE app.orders (
  id            bigint PRIMARY KEY,
  order_number  bigint NOT NULL DEFAULT nextval('app.order_number_seq'),
  customer_id   bigint NOT NULL REFERENCES app.customers(id),
  status        text NOT NULL DEFAULT 'open',
  amount_cents  integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_customer_idx ON app.orders(customer_id);

CREATE TABLE app.order_items (
  id         bigint PRIMARY KEY,
  order_id   bigint NOT NULL REFERENCES app.orders(id),
  sku        text NOT NULL,
  qty        integer NOT NULL,
  unit_cents integer NOT NULL
);

-- A side-effect sink the probes check: did a "read" actually write a row?
CREATE TABLE app.audit_log (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL DEFAULT current_user,
  action     text NOT NULL,
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);

-- A SECURITY DEFINER function that writes. It runs as its owner, so a caller
-- who only has EXECUTE can cause a write without any table privilege. This is
-- the classic "read-only role, writing function" gap.
CREATE OR REPLACE FUNCTION app.record_touch(p_note text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
DECLARE new_id bigint;
BEGIN
  INSERT INTO app.audit_log(action, note) VALUES ('record_touch', p_note) RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- A function whose body holds a value the author assumed only the owner could
-- read. A read_only role can read the source text from pg_proc.prosrc.
CREATE OR REPLACE FUNCTION app.sign_webhook(payload text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE signing_key text := 'whsec_demo_51Hf0cJ2kLpQ9seedonly';
BEGIN
  RETURN md5(signing_key || payload);
END;
$$;

-- A view the app reads from.
CREATE VIEW app.open_orders AS
  SELECT o.id, o.order_number, c.email, o.amount_cents
  FROM app.orders o JOIN app.customers c ON c.id = o.customer_id
  WHERE o.status = 'open';
