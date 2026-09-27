// Browser smoke test: boots the real index.html/app.js against the
// in-memory fake-firebase.js stub (Auth + Firestore, no live Firebase
// project needed) and drives the actual UI end to end: sign in, set up
// a profile, create a session, join it, and check the per-person
// settle-up restrictions render correctly. Not shipped with the app;
// development-time check only. Does NOT test firestore.rules itself —
// those only run for real against Google's servers — this checks the
// app's own logic and rendering given honest data.
import { chromium } from "playwright";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

let failed = false;
function check(name, cond) {
  if (cond) console.log("ok - " + name);
  else { console.error("FAIL - " + name); failed = true; }
}

const server = spawn("python3", ["-m", "http.server", "8981"], { cwd: root });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage();
const pageErrors = [];
page.on("console", (msg) => { if (msg.type() === "error") pageErrors.push(msg.text()); });
page.on("pageerror", (err) => pageErrors.push(String(err)));

// --- Test 1: default shipped config (REPLACE_ME) shows setup-needed message ---
await page.goto("http://localhost:8981/index.html");
await page.waitForSelector(".panel");
check("shows setup-needed message with default REPLACE_ME config",
  (await page.textContent("body")).includes("connect a database"));

// --- Test 2: full interactive flow against fake Auth + Firestore ---
const fakeFirebaseSrc = fs.readFileSync(path.join(__dirname, "fake-firebase.js"), "utf8");
await page.route("**/firebasejs/**", (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
await page.route("**/firebase-config.js", (route) =>
  route.fulfill({ status: 200, contentType: "application/javascript", body: 'const firebaseConfig = { apiKey: "test-key" };' })
);
await page.addInitScript({ content: fakeFirebaseSrc });

await page.goto("http://localhost:8981/index.html");
await page.waitForSelector("#signin-btn", { timeout: 5000 });
check("shows sign-in screen before authentication", true);

await page.click("#signin-btn");
await page.waitForSelector("#profile-setup-form", { timeout: 5000 });
check("prompts for profile setup on first sign-in (no player linked to this Google account yet)", true);

await page.fill("#setup-name", "A");
await page.fill("#setup-payment-info", "@a-payment-handle");
await page.click('#profile-setup-form button[type="submit"]');

await page.waitForSelector("#connection-status.status-connected", { timeout: 5000 });
check("after profile setup, connects and shows the app", true);
await page.waitForSelector(".payment-status-clear", { timeout: 5000 });
check("payment status panel shows 'All payment settled' when there's nothing outstanding",
  (await page.textContent("#payment-status")).includes("All payment settled"));
check("account area shows my name", (await page.textContent("#account-area")).includes("A"));
check("account area shows my saved payment info", (await page.textContent("#account-area")).includes("@a-payment-handle"));

// Payers are picked from existing players, not typed — so "B" needs to
// already exist as a player before it can show up in that dropdown.
await page.evaluate(() => firebase.firestore().collection("players").add({ name: "B", paymentInfo: "", uid: null }));

// Create a session: courtCost 100, payer A paid 60 (me), payer B paid 40
await page.goto("http://localhost:8981/index.html#/new");
await page.fill('[name="location"]', "Test Sports Centre");
await page.fill('[name="courtCost"]', "100");
const payerRow1 = page.locator(".payer-row").first();
await payerRow1.locator(".payer-name").selectOption({ label: "A" });
await payerRow1.locator(".payer-amount").fill("60");
await page.click("#add-payer-btn");
const payerRow2 = page.locator(".payer-row").nth(1);
await payerRow2.locator(".payer-name").selectOption({ label: "B" });
await payerRow2.locator(".payer-amount").fill("40");
check("payer select only offers existing players (no free-text option to invent a new one)",
  (await payerRow2.locator(".payer-name option").allTextContents()).sort().join(",") === ["A", "B", "Select player…"].sort().join(","));
await page.click('#new-session-form button[type="submit"]');

await page.waitForSelector(".session-title:not(:has-text('Loading'))", { timeout: 5000 });
check("navigated to new session detail page after creation", page.url().includes("#/session/"));
check("payer 'A' reused my existing player record rather than duplicating it",
  (await page.textContent(".payers-summary-list")).includes("A (£60.00)"));

const sessionId = decodeURIComponent(page.url().split("#/session/")[1]);

// Seed the other 9 participants directly through the (fake) Firestore
// API, simulating other people having already joined from their own
// accounts — a single Playwright session can only really be signed in
// as one Google user at a time.
await page.evaluate(async (sessionId) => {
  const db = firebase.firestore();
  const playersSnap = await db.collection("players").get();
  const byName = {};
  playersSnap.docs.forEach((d) => { byName[d.data().name] = d.id; });
  const names = ["B", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];
  for (const n of names) {
    let id = byName[n];
    if (!id) {
      const ref = await db.collection("players").add({ name: n, paymentInfo: "", uid: null });
      id = ref.id;
    }
    await db.collection("sessions").doc(sessionId).collection("participants").doc(id).set({
      playerId: id, name: n, hasSettled: false,
    });
  }
}, sessionId);

// Now join as myself (the 10th participant) through the actual UI.
await page.waitForSelector("#join-btn", { timeout: 5000 });
await page.click("#join-btn");
await page.waitForFunction(() => document.getElementById("participant-list").children.length >= 10, { timeout: 5000 });

check("all 10 participants show up in the list", (await page.locator(".participant-row").count()) === 10);
check("cost per person shown as £10.00 (100 / 10)", (await page.textContent(".stat-per-person")).includes("10.00"));

// Per-person restriction: only my own row should have an editable
// checkbox; everyone else should show static paid/unpaid text.
check("exactly one editable 'paid' checkbox (mine)", (await page.locator(".settled-checkbox").count()) === 1);
check("the other nine participants show static status text, not checkboxes",
  (await page.locator(".settled-status").count()) === 9);

// Settle up is admin-gated: I created this session but I'm not an
// admin yet, so I get no "Calculate transfers" button — just a
// not-yet-calculated placeholder, same as any other regular member.
check("no 'Calculate transfers' button for a non-admin creator", (await page.locator("#settle-btn").count()) === 0);
check("settle area shows a not-yet-calculated placeholder for non-admins",
  (await page.textContent("#settle-result")).includes("calculated the settle-up yet"));

// Toggle my own "paid" checkbox and confirm it persists.
const myCheckbox = page.locator(".settled-checkbox");
await myCheckbox.check();
await page.waitForTimeout(300);
check("my settled checkbox stays checked after the round-trip update", await myCheckbox.isChecked());

// Withdraw from the session: confirm dialog, then I drop out of the
// participant list and the "Join" button reappears in my place.
page.once("dialog", (dialog) => {
  check("withdraw shows a confirmation dialog mentioning I've already paid", dialog.message().includes("paid"));
  dialog.accept();
});
await page.click("#withdraw-btn");
await page.waitForFunction(() => document.getElementById("participant-list").children.length <= 9, { timeout: 5000 });
check("withdrawing drops the participant count back to 9", (await page.locator(".participant-row").count()) === 9);
check("cost per person recomputes to £11.11 (100 / 9) after withdrawing",
  (await page.textContent(".stat-per-person")).includes("11.11"));
await page.waitForSelector("#join-btn", { timeout: 5000 });
check("the Join button reappears after withdrawing", true);

// Cancel the session (I'm the creator): confirm dialog, banner appears,
// join is blocked, and the home list badge reflects it.
page.once("dialog", (dialog) => dialog.accept());
await page.click("#session-toggle-btn");
await page.waitForSelector("#cancelled-banner:not([hidden])", { timeout: 5000 });
check("cancelled banner shows after cancelling", true);
check("join area explains the session is cancelled instead of offering to join",
  (await page.textContent("#join-area")).includes("cancelled"));

await page.goto("http://localhost:8981/index.html#/");
await page.waitForSelector(".badge-cancelled", { timeout: 5000 });
check("home list shows a 'cancelled' badge for the cancelled session", (await page.textContent(".badge-cancelled")).includes("cancelled"));

// Reopen it: banner clears and joining works again.
await page.goto("http://localhost:8981/index.html#/session/" + encodeURIComponent(sessionId));
await page.waitForSelector("#session-toggle-btn", { timeout: 5000 });
await page.click("#session-toggle-btn");
await page.waitForFunction(() => document.getElementById("cancelled-banner").hidden === true, { timeout: 5000 });
check("cancelled banner clears after reopening", true);
await page.waitForSelector("#join-btn", { timeout: 5000 });
check("Join button is offered again after reopening", true);

// Edit the session (I'm the creator): form prefills with existing
// values, and saving updates the doc in place rather than creating a
// new one.
await page.click("#edit-session-link");
await page.waitForSelector("#new-session-form", { timeout: 5000 });
check("edit form heading says 'Edit session'", (await page.textContent(".panel-header h2")) === "Edit session");
check("edit form prefills the existing location", await page.inputValue('[name="location"]') === "Test Sports Centre");
check("edit form prefills the existing court cost", await page.inputValue('[name="courtCost"]') === "100");
check("edit form prefills both existing payer rows", (await page.locator(".payer-row").count()) === 2);
check("edit form pre-selects the correct existing payer in each row",
  (await page.locator(".payer-name").evaluateAll((els) => els.map((el) => el.selectedOptions[0]?.textContent))).sort().join(",") === "A,B");

await page.fill('[name="location"]', "Updated Sports Centre");
await page.fill('[name="courtCost"]', "120");
await page.click('#new-session-form button[type="submit"]');

await page.waitForFunction(() => document.querySelector(".session-sub")?.textContent === "Updated Sports Centre", { timeout: 5000 });
check("session detail reflects the edited location", true);
check("editing didn't create a second session (URL still points at the same id)",
  decodeURIComponent(page.url().split("#/session/")[1]) === sessionId);
check("cost per person recomputes from the edited court cost (£120 / 9 = £13.33)",
  (await page.textContent(".stat-per-person")).includes("13.33"));

// Admin role: console-managed via /admins/{uid} (simulated here with a
// direct Firestore write, standing in for someone hand-editing it in
// the Firebase console). Once granted, admin can mark anyone paid and
// remove anyone from a session, not just their own row.
await page.evaluate(() => firebase.firestore().collection("admins").doc("test-uid-1").set({ isAdmin: true }));
await page.waitForSelector(".admin-badge", { timeout: 5000 });
check("admin badge appears once granted, live with no reload", true);
check("every row gets an editable 'paid' checkbox once I'm admin (I'm not a participant myself right now)",
  (await page.locator(".settled-checkbox").count()) === 9);
check("every row also gets a remove button", (await page.locator(".remove-participant-btn").count()) === 9);

// Settle up: only admin gets the "Calculate transfers" button, and
// clicking it publishes the result for everyone (see below, after
// admin is revoked).
await page.waitForSelector("#settle-btn", { timeout: 5000 });
check("'Calculate transfers' button appears now that I'm admin", true);
await page.click("#settle-btn");
await page.waitForSelector(".transfer-row", { timeout: 5000 });
check("calculating produces at least one transfer", (await page.locator(".transfer-row").count()) > 0);
const adminTransferTexts = await page.locator(".transfer-row").allTextContents();
check("my payment handle is shown on transfers routed to me",
  adminTransferTexts.some((t) => t.includes("@a-payment-handle")));
check("a Reset control appears once published", (await page.locator("#reset-settle-btn").count()) === 1);
check("the 'Calculate transfers' button is gone once published", (await page.locator("#settle-btn").count()) === 0);

const firstCheckbox = page.locator(".settled-checkbox").first();
await firstCheckbox.check();
await page.waitForTimeout(300);
check("admin can mark someone else's row as paid", await firstCheckbox.isChecked());

page.once("dialog", (dialog) => dialog.accept());
await page.locator(".remove-participant-btn").first().click();
await page.waitForFunction(() => document.getElementById("participant-list").children.length <= 8, { timeout: 5000 });
check("admin can remove someone else's row (participant count drops to 8)",
  (await page.locator(".participant-row").count()) === 8);

// Revoke admin: elevated controls disappear live, same as they appeared.
await page.evaluate(() => firebase.firestore().collection("admins").doc("test-uid-1").delete());
await page.waitForFunction(() => !document.querySelector(".admin-badge"), { timeout: 5000 });
check("admin badge disappears once revoked, live with no reload", true);
check("checkboxes revert to read-only status text once no longer admin",
  (await page.locator(".settled-checkbox").count()) === 0);
check("the settle-up result stays visible for everyone even after admin is revoked",
  (await page.locator(".transfer-row").count()) > 0);
check("no admin-only settle controls remain once revoked",
  (await page.locator("#reset-settle-btn").count()) === 0 && (await page.locator("#settle-btn").count()) === 0);

// Home page: the "x transfers needed" badge only counts transfers from
// people who haven't ticked "paid", and my payment status panel lists
// what's still owed to me from the published settle-up.
const outstandingCount = await page.evaluate(async (sessionId) => {
  const db = firebase.firestore();
  const parts = db.collection("sessions").doc(sessionId).collection("participants");
  const firstUnpaid = (await parts.get()).docs.find((d) => !d.data().hasSettled);
  await parts.doc(firstUnpaid.id).update({ hasSettled: true });
  const sessionDoc = await db.collection("sessions").doc(sessionId).get();
  const partsSnap = await db.collection("sessions").doc(sessionId).collection("participants").get();
  const session = Object.assign({}, sessionDoc.data(), { participants: partsSnap.docs.map((d) => d.data()) });
  return {
    all: SplitLogic.computeSettlement(session).length,
    outstanding: SplitLogic.computeOutstandingTransfers(session).length,
  };
}, sessionId);
check("someone marked paid, so fewer transfers are outstanding than in the full settle-up",
  outstandingCount.outstanding < outstandingCount.all);
await page.goto("http://localhost:8981/index.html#/");
await page.waitForSelector(".session-card .badge", { timeout: 5000 });
check("home badge counts only outstanding transfers",
  (await page.textContent(".session-card .badge")).startsWith(outstandingCount.outstanding + " transfer"));
await page.waitForSelector(".payment-status-owed .payment-status-row", { timeout: 5000 });
check("payment status panel lists what's still owed to me",
  (await page.locator(".payment-status-owed .payment-status-row").count()) > 0 &&
  (await page.textContent("#payment-status")).includes("owed to you"));
check("payment status panel shows nothing I owe (I paid up front)",
  (await page.locator(".payment-status-owe").count()) === 0);

await page.evaluate(async (sessionId) => {
  const db = firebase.firestore();
  const partsSnap = await db.collection("sessions").doc(sessionId).collection("participants").get();
  for (const d of partsSnap.docs) {
    await db.collection("sessions").doc(sessionId).collection("participants").doc(d.id).update({ hasSettled: true });
  }
}, sessionId);
await page.waitForSelector(".payment-status-clear", { timeout: 5000 });
check("payment status flips to 'All payment settled' once everyone has paid",
  (await page.textContent("#payment-status")).includes("All payment settled"));
check("home badge shows 'settled' once everyone has paid",
  (await page.textContent(".session-card .badge")) === "settled");

// Editing payment info via the header control (native prompt dialog).
page.once("dialog", (dialog) => dialog.accept("new-handle@example"));
await page.click("#edit-payinfo-btn");
await page.waitForFunction(() => document.getElementById("account-area").textContent.includes("new-handle@example"), { timeout: 5000 });
check("payment info updates after editing from the header", true);

// Sign out returns to the sign-in gate.
await page.click("#signout-btn");
await page.waitForSelector("#signin-btn", { timeout: 5000 });
check("signing out returns to the sign-in screen", true);

const realErrors = pageErrors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|gstatic\.com/.test(e));
check("no unexpected console/page errors during the whole flow", realErrors.length === 0);
if (realErrors.length) realErrors.forEach((e) => console.error("  console error: " + e));

await browser.close();
server.kill();
process.exit(failed ? 1 : 0);
