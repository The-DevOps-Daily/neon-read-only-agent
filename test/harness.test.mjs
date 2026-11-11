import test from "node:test";
import assert from "node:assert/strict";
import { customers, mulberry32, orders } from "../lib/fake.mjs";
import { parseSqlState } from "../lib/mcp.mjs";
import { PROBES, SIDE_EFFECT_PROBES } from "../lib/probes.mjs";

test("mulberry32 is deterministic and bounded", () => {
  const sequence = (seed) => {
    const rand = mulberry32(seed);
    return Array.from({ length: 6 }, () => rand());
  };
  const a = sequence(123);
  assert.deepEqual(a, sequence(123));
  assert.notDeepEqual(a, sequence(124));
  assert.ok(a.every((value) => value >= 0 && value < 1));
});

test("fake customers and orders are deterministic", () => {
  const customerRows = [...customers(4)];
  const orderRows = [...orders(6, 4)];
  assert.deepEqual(customerRows, [...customers(4)]);
  assert.equal(customerRows.length, 4);
  assert.deepEqual(orderRows, [...orders(6, 4)]);
  assert.equal(orderRows.length, 6);
  for (const order of orderRows) {
    assert.ok(order.items.length >= 1);
    assert.ok(order.customer_id >= 1 && order.customer_id <= 4);
  }
});

test("parseSqlState reads SQLSTATE errors", () => {
  assert.equal(parseSqlState("NeonDbError: denied\nSQLSTATE: 25006"), "25006");
  assert.equal(parseSqlState("NeonDbError: denied"), undefined);
});

test("probes declare complete expectations", () => {
  assert.equal(PROBES.length, 40);
  assert.equal(new Set(PROBES.map((probe) => probe.id)).size, 40);
  for (const probe of PROBES) {
    assert.deepEqual(Object.keys(probe.expect).sort(), ["S1", "S2", "S3", "S4"]);
    for (const expectation of Object.values(probe.expect)) {
      if (!expectation.allow) {
        assert.equal(typeof expectation.state, "string");
        assert.match(expectation.state, /^[0-9A-Z]{5}$/);
      }
    }
  }
});

test("side-effect probes are tracked probe effects", () => {
  const effects = new Set(["audit", "largeobject", "rolesetting", "notify"]);
  assert.ok(SIDE_EFFECT_PROBES.length > 0);
  for (const probe of SIDE_EFFECT_PROBES) {
    assert.ok(PROBES.includes(probe));
    assert.ok(effects.has(probe.effect));
  }
});
