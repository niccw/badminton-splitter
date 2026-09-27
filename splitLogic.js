/**
 * splitLogic.js
 *
 * Pure, framework-free functions for turning a session's payer/participant
 * data into (a) each person's net balance and (b) a minimal set of
 * transfers that settles everyone up.
 *
 * A "session" object looks like:
 * {
 *   courtCost: 100,
 *   payers: [ { playerId, name, amountPaid } ],       // who fronted the booking
 *   participants: [ { playerId, name, hasSettled } ], // everyone splitting the cost
 * }
 *
 * Loaded both in the browser (as a <script> global) and in Node for tests,
 * so it must not use ES modules or browser-only APIs.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SplitLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Round to the nearest cent/penny to avoid floating point drift
  // (e.g. 0.1 + 0.2 !== 0.3). All internal math works in integer "cents".
  function toCents(amount) {
    return Math.round(Number(amount || 0) * 100);
  }
  function fromCents(cents) {
    return Math.round(cents) / 100;
  }

  /**
   * Cost per participant, split evenly. Returns 0 if there are no
   * participants yet (avoids divide-by-zero while a session is still
   * filling up).
   */
  function computeCostPerPerson(session) {
    const n = (session.participants || []).length;
    if (n === 0) return 0;
    const totalCents = toCents(session.courtCost);
    // Split evenly in cents, remainder handled in computeBalances so the
    // sum of shares always exactly equals the total cost.
    return fromCents(Math.floor(totalCents / n));
  }

  /**
   * Net balance per person (in normal currency units, e.g. dollars/pounds).
   * Positive = this person is owed money overall.
   * Negative = this person owes money overall.
   *
   * A person who is both a payer AND a participant (the common case for
   * whoever booked the court) gets both sides applied automatically.
   *
   * Any leftover pennies from an uneven split (courtCost not evenly
   * divisible by participant count) are distributed one-cent-at-a-time to
   * the first participants in list order, so the shares always sum to
   * exactly courtCost.
   */
  function computeBalances(session) {
    const participants = session.participants || [];
    const payers = session.payers || [];
    const n = participants.length;

    const balances = {}; // playerId -> { name, cents }

    function ensure(playerId, name) {
      if (!balances[playerId]) {
        balances[playerId] = { playerId: playerId, name: name, cents: 0 };
      }
      return balances[playerId];
    }

    if (n > 0) {
      const totalCents = toCents(session.courtCost);
      const baseShare = Math.floor(totalCents / n);
      let remainder = totalCents - baseShare * n; // extra pennies to distribute

      participants.forEach(function (p, idx) {
        const entry = ensure(p.playerId, p.name);
        let share = baseShare;
        if (remainder > 0) {
          share += 1;
          remainder -= 1;
        }
        entry.cents -= share;
      });
    }

    payers.forEach(function (payer) {
      const entry = ensure(payer.playerId, payer.name);
      entry.cents += toCents(payer.amountPaid);
    });

    return Object.keys(balances).map(function (id) {
      const b = balances[id];
      return { playerId: b.playerId, name: b.name, balance: fromCents(b.cents) };
    });
  }

  /**
   * Greedy debt-simplification: repeatedly match the largest creditor with
   * the largest debtor, settle the smaller of the two amounts, and repeat.
   * This is the standard approach used by bill-splitting apps (Splitwise
   * and similar) and produces a minimal-or-near-minimal number of
   * transfers in practice — exact global minimisation is NP-hard, but
   * greedy matches the optimum in the vast majority of real cases,
   * including every case with a small number of distinct amounts (as in
   * a badminton group).
   *
   * Returns an array of { from, fromId, to, toId, amount } transfers.
   */
  function computeSettlement(session) {
    const balances = computeBalances(session)
      .map(function (b) {
        return { playerId: b.playerId, name: b.name, cents: toCents(b.balance) };
      })
      .filter(function (b) {
        return b.cents !== 0;
      });

    const creditors = balances.filter(function (b) { return b.cents > 0; })
      .sort(function (a, b) { return b.cents - a.cents; });
    const debtors = balances.filter(function (b) { return b.cents < 0; })
      .sort(function (a, b) { return a.cents - b.cents; }); // most negative first

    const transfers = [];
    let ci = 0, di = 0;

    while (ci < creditors.length && di < debtors.length) {
      const creditor = creditors[ci];
      const debtor = debtors[di];
      const amount = Math.min(creditor.cents, -debtor.cents);

      if (amount > 0) {
        transfers.push({
          fromId: debtor.playerId,
          from: debtor.name,
          toId: creditor.playerId,
          to: creditor.name,
          amount: fromCents(amount),
        });
      }

      creditor.cents -= amount;
      debtor.cents += amount;

      if (creditor.cents === 0) ci++;
      if (debtor.cents === 0) di++;
    }

    return transfers;
  }

  /**
   * The transfers from computeSettlement that are still waiting to be
   * paid. A participant ticking "paid" (hasSettled) means they've paid
   * their share, so every transfer *from* them is done — even when the
   * greedy split routed their debt to more than one creditor.
   */
  function computeOutstandingTransfers(session) {
    const settled = {};
    (session.participants || []).forEach(function (p) {
      if (p.hasSettled) settled[p.playerId] = true;
    });
    return computeSettlement(session).filter(function (t) {
      return !settled[t.fromId];
    });
  }

  return {
    computeCostPerPerson: computeCostPerPerson,
    computeBalances: computeBalances,
    computeSettlement: computeSettlement,
    computeOutstandingTransfers: computeOutstandingTransfers,
  };
});
