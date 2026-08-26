/**
 * Plain-Node test runner (no dependencies) for splitLogic.js.
 * Run with: node tests/splitLogic.test.js
 */
const assert = require("assert");
const SplitLogic = require("../splitLogic.js");

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    console.error("  FAIL - " + name);
    console.error("    " + e.message);
    process.exitCode = 1;
  }
}

function totalTransferred(transfers) {
  return transfers.reduce((sum, t) => sum + t.amount, 0);
}

console.log("computeCostPerPerson");
check("splits evenly", () => {
  const cost = SplitLogic.computeCostPerPerson({
    courtCost: 100,
    participants: [1, 2, 3, 4, 5].map((i) => ({ playerId: "p" + i, name: "P" + i })),
  });
  assert.strictEqual(cost, 20);
});
check("returns 0 with no participants", () => {
  const cost = SplitLogic.computeCostPerPerson({ courtCost: 100, participants: [] });
  assert.strictEqual(cost, 0);
});

console.log("computeBalances");
check("uneven split distributes remainder pennies, sums to exact total", () => {
  // 10 cost over 3 people = 3.33 each -> pennies must sum back to 10.00 exactly
  const session = {
    courtCost: 10,
    payers: [],
    participants: [
      { playerId: "a", name: "A" },
      { playerId: "b", name: "B" },
      { playerId: "c", name: "C" },
    ],
  };
  const balances = SplitLogic.computeBalances(session);
  const sum = balances.reduce((s, b) => s + b.balance, 0);
  assert.strictEqual(Math.round(sum * 100) / 100, -10);
});

console.log("computeSettlement — user's worked example (2 payers, 10 participants)");
check("A paid 60, B paid 40, cost 100 split 10 ways ($10 each)", () => {
  const participants = [];
  for (let i = 1; i <= 10; i++) participants.push({ playerId: "p" + i, name: "P" + i });
  // p1 and p2 are the same people as payers A and B (they booked AND played)
  participants[0] = { playerId: "p1", name: "A" };
  participants[1] = { playerId: "p2", name: "B" };
  const session = {
    courtCost: 100,
    payers: [
      { playerId: "p1", name: "A", amountPaid: 60 },
      { playerId: "p2", name: "B", amountPaid: 40 },
    ],
    participants: participants,
  };
  const transfers = SplitLogic.computeSettlement(session);

  // Balances: A = 60-10=+50, B=40-10=+30, others = -10 each (x8)
  // Greedy should produce exactly 8 transfers (5 into A, 3 into B),
  // and never route money through anyone other than A or B, since they
  // are the only creditors.
  assert.strictEqual(transfers.length, 8);
  transfers.forEach((t) => {
    assert.ok(t.to === "A" || t.to === "B", "transfer should go to a payer: " + JSON.stringify(t));
    assert.ok(t.from !== "A" && t.from !== "B", "payer should not be sending money: " + JSON.stringify(t));
  });
  assert.strictEqual(totalTransferred(transfers), 80); // 50 + 30 owed to the payers
});

check("even split between 2 payers of equal share settles in exactly 8 (optimal)", () => {
  const participants = [];
  for (let i = 1; i <= 10; i++) participants.push({ playerId: "p" + i, name: "P" + i });
  participants[0] = { playerId: "p1", name: "A" };
  participants[1] = { playerId: "p2", name: "B" };
  const session = {
    courtCost: 100,
    payers: [
      { playerId: "p1", name: "A", amountPaid: 50 },
      { playerId: "p2", name: "B", amountPaid: 50 },
    ],
    participants: participants,
  };
  const transfers = SplitLogic.computeSettlement(session);
  assert.strictEqual(transfers.length, 8);
});

check("single payer covering everything: N-1 transfers, all to the payer", () => {
  const participants = [];
  for (let i = 1; i <= 6; i++) participants.push({ playerId: "p" + i, name: "P" + i });
  participants[0] = { playerId: "p1", name: "A" };
  const session = {
    courtCost: 60,
    payers: [{ playerId: "p1", name: "A", amountPaid: 60 }],
    participants: participants,
  };
  const transfers = SplitLogic.computeSettlement(session);
  assert.strictEqual(transfers.length, 5); // everyone except A pays A
  transfers.forEach((t) => assert.strictEqual(t.to, "A"));
  assert.strictEqual(totalTransferred(transfers), 50); // 5 people x $10
});

check("everyone already settled (balances net to zero) => no transfers", () => {
  const session = {
    courtCost: 30,
    payers: [{ playerId: "p1", name: "A", amountPaid: 10 }, { playerId: "p2", name: "B", amountPaid: 10 }, { playerId: "p3", name: "C", amountPaid: 10 }],
    participants: [
      { playerId: "p1", name: "A" },
      { playerId: "p2", name: "B" },
      { playerId: "p3", name: "C" },
    ],
  };
  const transfers = SplitLogic.computeSettlement(session);
  assert.strictEqual(transfers.length, 0);
});

check("payer who is not a participant (books court but doesn't play) still gets repaid in full", () => {
  const session = {
    courtCost: 40,
    payers: [{ playerId: "org", name: "Organizer", amountPaid: 40 }],
    participants: [
      { playerId: "p1", name: "P1" },
      { playerId: "p2", name: "P2" },
      { playerId: "p3", name: "P3" },
      { playerId: "p4", name: "P4" },
    ],
  };
  const transfers = SplitLogic.computeSettlement(session);
  assert.strictEqual(transfers.length, 4);
  assert.strictEqual(totalTransferred(transfers), 40);
  transfers.forEach((t) => assert.strictEqual(t.to, "Organizer"));
});

console.log(`\n${passed} test(s) passed` + (process.exitCode ? ", some FAILED" : ""));
