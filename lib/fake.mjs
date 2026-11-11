// Deterministic fake data. mulberry32 (Math.imul based), seeded, so a re-run
// generates the same rows. The textbook LCG degrades past 2^53 in JS floats;
// this does not.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["ada", "alan", "grace", "linus", "edsger", "barbara", "ken", "dennis", "margaret", "donald", "john", "radia"];
const LAST = ["lovelace", "turing", "hopper", "torvalds", "dijkstra", "liskov", "thompson", "ritchie", "hamilton", "knuth", "mccarthy", "perlman"];
const SKUS = ["SKU-RED", "SKU-BLUE", "SKU-GREEN", "SKU-BLACK", "SKU-WHITE", "SKU-GOLD"];

export function* customers(n, seed = 1) {
  const rand = mulberry32(seed);
  for (let i = 1; i <= n; i++) {
    const f = FIRST[Math.floor(rand() * FIRST.length)];
    const l = LAST[Math.floor(rand() * LAST.length)];
    yield { id: i, email: `${f}.${l}.${i}@example.test`, display_name: `${f} ${l}` };
  }
}

export function* orders(n, customerCount, seed = 2) {
  const rand = mulberry32(seed);
  let itemId = 1;
  for (let i = 1; i <= n; i++) {
    const customerId = 1 + Math.floor(rand() * customerCount);
    const amount = 500 + Math.floor(rand() * 50000);
    const status = rand() < 0.6 ? "open" : "shipped";
    const items = [];
    const itemCount = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < itemCount; k++) {
      items.push({ id: itemId++, order_id: i, sku: SKUS[Math.floor(rand() * SKUS.length)], qty: 1 + Math.floor(rand() * 4), unit_cents: 200 + Math.floor(rand() * 4000) });
    }
    yield { id: i, customer_id: customerId, status, amount_cents: amount, items };
  }
}
