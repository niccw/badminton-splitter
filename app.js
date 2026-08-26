/**
 * app.js — Badminton Splitter
 *
 * A tiny hash-routed vanilla JS app backed by Firestore + Firebase Auth
 * (Google sign-in). No build step, no framework.
 *
 * Identity model: every visitor must sign in with Google. On first
 * sign-in they claim (or create) a "player" record — that's their
 * identity in the group from then on. You can only join sessions as
 * yourself, and only toggle your own "paid" status; this is enforced
 * both here and, more importantly, in firestore.rules (client-side
 * checks are for UX, the rules are what actually protects the data).
 *
 * Data model:
 *   players/{playerId}            { name, paymentInfo, uid, createdAt }
 *   sessions/{sessionId}          { date, location, courtCost, notes,
 *                                    payers: [{playerId,name,amountPaid}],
 *                                    createdByUid, createdAt }
 *   sessions/{id}/participants/{playerId}
 *                                  { playerId, name, hasSettled, joinedAt }
 *     (doc id == playerId, so security rules can check "is this your row")
 */
(function () {
  "use strict";

  const appEl = document.getElementById("app");
  const statusEl = document.getElementById("connection-status");
  const accountEl = document.getElementById("account-area");
  const datalist = document.getElementById("player-names-datalist");

  let db = null;
  let auth = null;
  let configOk = firebaseConfig && firebaseConfig.apiKey && firebaseConfig.apiKey !== "REPLACE_ME";

  let currentUser = null; // Firebase Auth user
  let currentPlayer = null; // { id, name, paymentInfo, uid }
  let allPlayers = []; // live cache of the whole players collection

  let unsubscribePlayers = null;
  let unsubscribeSessionList = null;
  let unsubscribeSessionDetail = null;
  let unsubscribeParticipants = null;
  let homeParticipantUnsubs = {}; // sessionId -> unsubscribe fn
  let latestSession = null;
  let latestParticipants = [];

  // ---------------------------------------------------------------
  // Firebase init
  // ---------------------------------------------------------------
  if (configOk) {
    try {
      firebase.initializeApp(firebaseConfig);
      db = firebase.firestore();
      auth = firebase.auth();
      setStatus("connecting", "connecting…");
    } catch (e) {
      configOk = false;
      console.error(e);
    }
  }
  if (!configOk) setStatus("error", "not configured");

  function setStatus(kind, text) {
    statusEl.className = "status status-" + kind;
    statusEl.textContent = text;
  }

  // ---------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------
  function money(n) {
    const num = Number(n || 0);
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  }
  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  // ---------------------------------------------------------------
  // Auth / identity
  // ---------------------------------------------------------------
  function boot() {
    if (!configOk) {
      renderConfigNeeded();
      return;
    }
    auth.onAuthStateChanged(function (user) {
      currentUser = user;
      teardownEverything();

      if (!user) {
        currentPlayer = null;
        paintAccountArea();
        renderSignIn();
        return;
      }

      resolveMyPlayer(user).then(function () {
        paintAccountArea();
        startPlayersListener();
        router();
      }).catch(function (err) {
        console.error(err);
        appEl.innerHTML = '<div class="error-banner">Could not set up your account: ' + escapeHtml(err.message) + "</div>";
      });
    });
  }

  function paintAccountArea() {
    if (!currentUser || !currentPlayer) {
      accountEl.innerHTML = "";
      return;
    }
    accountEl.innerHTML =
      '<span class="account-name">' + escapeHtml(currentPlayer.name) + "</span>" +
      '<button id="edit-payinfo-btn" class="btn btn-secondary btn-small">' +
      (currentPlayer.paymentInfo ? "pay: " + escapeHtml(currentPlayer.paymentInfo) : "set payment info") +
      "</button>" +
      '<button id="signout-btn" class="btn btn-secondary btn-small">Sign out</button>';

    document.getElementById("edit-payinfo-btn").addEventListener("click", function () {
      const val = window.prompt(
        "How should people pay you back? (a payment link/handle, or leave blank)",
        currentPlayer.paymentInfo || ""
      );
      if (val === null) return;
      updateMyPaymentInfo(val.trim());
    });
    document.getElementById("signout-btn").addEventListener("click", function () {
      auth.signOut();
    });
  }

  function updateMyPaymentInfo(newInfo) {
    return db.collection("players").doc(currentPlayer.id).update({ paymentInfo: newInfo })
      .then(function () {
        currentPlayer.paymentInfo = newInfo;
        paintAccountArea();
      })
      .catch(function (err) {
        console.error(err);
        alert("Could not update payment info: " + err.message);
      });
  }

  function renderSignIn() {
    const tpl = document.getElementById("tpl-signin");
    appEl.innerHTML = "";
    appEl.appendChild(tpl.content.cloneNode(true));
    document.getElementById("signin-btn").addEventListener("click", function () {
      const provider = new firebase.auth.GoogleAuthProvider();
      auth.signInWithPopup(provider).catch(function (err) {
        console.error(err);
        alert("Sign-in failed: " + err.message);
      });
    });
  }

  /**
   * Resolve the signed-in Google user to a player record. If they've
   * never signed in before, walk them through claiming or creating one
   * (renderProfileSetup resolves the returned promise once that's done).
   */
  function resolveMyPlayer(user) {
    return db.collection("players").where("uid", "==", user.uid).limit(1).get().then(function (snap) {
      if (!snap.empty) {
        const d = snap.docs[0];
        currentPlayer = Object.assign({ id: d.id }, d.data());
        return currentPlayer;
      }
      return new Promise(function (resolve, reject) {
        renderProfileSetup(user, resolve, reject);
      });
    });
  }

  function renderProfileSetup(user, resolve, reject) {
    const tpl = document.getElementById("tpl-profile-setup");
    appEl.innerHTML = "";
    appEl.appendChild(tpl.content.cloneNode(true));

    const nameInput = document.getElementById("setup-name");
    nameInput.value = user.displayName || "";
    const payInfoInput = document.getElementById("setup-payment-info");
    const form = document.getElementById("profile-setup-form");

    db.collection("players").where("uid", "==", null).get().then(function (snap) {
      const dl = document.getElementById("unclaimed-names-datalist");
      dl.innerHTML = "";
      snap.docs.forEach(function (d) {
        const opt = document.createElement("option");
        opt.value = d.data().name;
        dl.appendChild(opt);
      });
    }).catch(function (err) {
      console.warn("could not load unclaimed player suggestions", err);
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      claimOrCreatePlayer(name, user.uid, payInfoInput.value.trim())
        .then(function (player) {
          currentPlayer = player;
          resolve(player);
        })
        .catch(function (err) {
          console.error(err);
          alert("Could not set up your profile: " + err.message);
          submitBtn.disabled = false;
        });
    });
  }

  /**
   * If an unclaimed placeholder player with this name already exists
   * (e.g. someone listed them as a payer before they ever signed in),
   * claim it by attaching this uid. Otherwise create a brand new player.
   */
  function claimOrCreatePlayer(name, uid, paymentInfo) {
    const norm = name.trim().toLowerCase();
    return db.collection("players").where("uid", "==", null).get().then(function (snap) {
      const match = snap.docs.find(function (d) { return d.data().name.trim().toLowerCase() === norm; });
      if (match) {
        const updates = { uid: uid };
        if (paymentInfo && !match.data().paymentInfo) updates.paymentInfo = paymentInfo;
        return db.collection("players").doc(match.id).update(updates).then(function () {
          return Object.assign({ id: match.id }, match.data(), updates);
        });
      }
      return db.collection("players").add({
        name: name,
        paymentInfo: paymentInfo || "",
        uid: uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      }).then(function (ref) {
        return { id: ref.id, name: name, paymentInfo: paymentInfo || "", uid: uid };
      });
    });
  }

  // ---------------------------------------------------------------
  // Player directory (for autocomplete on the "who paid" fields, and
  // for looking up payment info when rendering settle-up results)
  // ---------------------------------------------------------------
  function startPlayersListener() {
    if (!db || unsubscribePlayers) return;
    unsubscribePlayers = db.collection("players").onSnapshot(
      function (snap) {
        allPlayers = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        refreshDatalist();
        setStatus("connected", "live");
      },
      function (err) {
        console.error("players listener error", err);
        setStatus("error", "connection error");
      }
    );
  }

  function refreshDatalist() {
    datalist.innerHTML = "";
    allPlayers
      .slice()
      .sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (p) {
        const opt = document.createElement("option");
        opt.value = p.name;
        datalist.appendChild(opt);
      });
  }

  function findPlayerByName(name) {
    const norm = name.trim().toLowerCase();
    return allPlayers.find(function (p) { return p.name.trim().toLowerCase() === norm; });
  }

  /**
   * Used only for the "who paid the booking" fields on session creation
   * — those can name anyone in the group, whether or not that person
   * has signed in yet. Creates an unclaimed placeholder if new.
   */
  function getOrCreatePlaceholderPlayer(name) {
    name = (name || "").trim();
    if (!name) return Promise.reject(new Error("Name is required"));
    const existing = findPlayerByName(name);
    if (existing) return Promise.resolve(existing);
    return db.collection("players").add({
      name: name,
      paymentInfo: "",
      uid: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).then(function (ref) {
      return { id: ref.id, name: name, paymentInfo: "", uid: null };
    });
  }

  // ---------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------
  function router() {
    teardownSessionDetail();
    teardownHomeParticipantListeners();
    const hash = window.location.hash || "#/";

    if (hash === "#/" || hash === "") {
      renderHome();
    } else if (hash === "#/new") {
      renderNewSession();
    } else if (hash.indexOf("#/session/") === 0) {
      const id = decodeURIComponent(hash.slice("#/session/".length));
      renderSessionDetail(id);
    } else {
      renderHome();
    }
  }
  window.addEventListener("hashchange", function () {
    if (currentUser && currentPlayer) router();
  });

  function teardownSessionDetail() {
    if (unsubscribeSessionDetail) { unsubscribeSessionDetail(); unsubscribeSessionDetail = null; }
    if (unsubscribeParticipants) { unsubscribeParticipants(); unsubscribeParticipants = null; }
    latestSession = null;
    latestParticipants = [];
  }
  function teardownHomeParticipantListeners() {
    if (unsubscribeSessionList) { unsubscribeSessionList(); unsubscribeSessionList = null; }
    Object.keys(homeParticipantUnsubs).forEach(function (id) { homeParticipantUnsubs[id](); });
    homeParticipantUnsubs = {};
  }
  function teardownEverything() {
    teardownSessionDetail();
    teardownHomeParticipantListeners();
    if (unsubscribePlayers) { unsubscribePlayers(); unsubscribePlayers = null; }
  }

  function renderConfigNeeded() {
    appEl.innerHTML =
      '<section class="panel">' +
      "<h2>Almost there — connect a database</h2>" +
      "<p>This app needs a free Firebase project to store sessions and players so everyone in your group sees the same data. " +
      "Open <code>firebase-config.js</code> in the project files and fill in your project's config values, then reload this page. " +
      "Full step-by-step instructions are in <code>README.md</code>.</p>" +
      "</section>";
  }

  // ---------------------------------------------------------------
  // Home: session list
  // ---------------------------------------------------------------
  function renderHome() {
    const tpl = document.getElementById("tpl-home");
    appEl.innerHTML = "";
    appEl.appendChild(tpl.content.cloneNode(true));

    const listEl = document.getElementById("session-list");
    listEl.innerHTML = '<p class="loading">Loading sessions…</p>';

    unsubscribeSessionList = db.collection("sessions").orderBy("date", "desc").onSnapshot(
      function (snap) {
        if (snap.empty) {
          listEl.innerHTML = '<p class="empty-state">No sessions yet. Create your first one!</p>';
          teardownHomeParticipantListeners();
          return;
        }
        listEl.innerHTML = "";
        const seenIds = {};
        snap.docs.forEach(function (doc) {
          const session = Object.assign({ id: doc.id }, doc.data());
          seenIds[session.id] = true;
          const cardWrap = document.createElement("div");
          listEl.appendChild(cardWrap);
          attachHomeParticipantListener(session, cardWrap);
        });
        Object.keys(homeParticipantUnsubs).forEach(function (id) {
          if (!seenIds[id]) { homeParticipantUnsubs[id](); delete homeParticipantUnsubs[id]; }
        });
      },
      function (err) {
        console.error(err);
        listEl.innerHTML = '<div class="error-banner">Could not load sessions: ' + escapeHtml(err.message) + "</div>";
      }
    );
  }

  function attachHomeParticipantListener(session, containerEl) {
    if (homeParticipantUnsubs[session.id]) homeParticipantUnsubs[session.id]();
    homeParticipantUnsubs[session.id] = db
      .collection("sessions").doc(session.id).collection("participants")
      .onSnapshot(function (snap) {
        const participants = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        containerEl.innerHTML = "";
        containerEl.appendChild(renderSessionCard(Object.assign({}, session, { participants: participants })));
      });
  }

  function renderSessionCard(session) {
    const tpl = document.getElementById("tpl-session-card");
    const node = tpl.content.cloneNode(true);
    const a = node.querySelector(".session-card");
    a.href = "#/session/" + encodeURIComponent(session.id);
    node.querySelector(".session-card-date").textContent = formatDate(session.date);
    node.querySelector(".session-card-location").textContent = session.location || "";
    node.querySelector(".chip-cost").textContent = "£" + money(session.courtCost);
    const participantCount = (session.participants || []).length;
    node.querySelector(".chip-people").textContent = participantCount + (participantCount === 1 ? " person" : " people");

    const transfers = SplitLogic.computeSettlement(session);
    const badge = node.querySelector(".badge");
    if (transfers.length === 0 && participantCount > 0) {
      badge.textContent = "settled";
    } else if (transfers.length > 0) {
      badge.textContent = transfers.length + " transfer" + (transfers.length === 1 ? "" : "s") + " needed";
    } else {
      badge.textContent = "no one joined yet";
    }
    return node;
  }

  // ---------------------------------------------------------------
  // New session form
  // ---------------------------------------------------------------
  function renderNewSession() {
    const tpl = document.getElementById("tpl-new-session");
    appEl.innerHTML = "";
    appEl.appendChild(tpl.content.cloneNode(true));

    const payersList = document.getElementById("payers-list");
    const addPayerBtn = document.getElementById("add-payer-btn");
    const form = document.getElementById("new-session-form");

    function addPayerRow() {
      const tpl2 = document.getElementById("tpl-payer-row");
      const node = tpl2.content.cloneNode(true);
      node.querySelector(".remove-payer-btn").addEventListener("click", function (e) {
        e.target.closest(".payer-row").remove();
      });
      payersList.appendChild(node);
    }
    addPayerBtn.addEventListener("click", addPayerRow);
    addPayerRow();

    form.querySelector('[name="date"]').value = new Date().toISOString().slice(0, 10);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const fd = new FormData(form);
      const date = fd.get("date");
      const location = (fd.get("location") || "").trim();
      const courtCost = parseFloat(fd.get("courtCost"));
      const notes = (fd.get("notes") || "").trim();

      const payerRows = Array.prototype.slice.call(payersList.querySelectorAll(".payer-row"));
      const payerInputs = payerRows
        .map(function (row) {
          return {
            name: row.querySelector(".payer-name").value.trim(),
            amount: parseFloat(row.querySelector(".payer-amount").value),
          };
        })
        .filter(function (p) { return p.name && !isNaN(p.amount); });

      if (!payerInputs.length) {
        alert("Add at least one person who paid for the booking.");
        submitBtn.disabled = false;
        return;
      }

      Promise.all(payerInputs.map(function (p) { return getOrCreatePlaceholderPlayer(p.name); }))
        .then(function (players) {
          const payers = players.map(function (player, i) {
            return { playerId: player.id, name: player.name, amountPaid: payerInputs[i].amount };
          });
          return db.collection("sessions").add({
            date: date,
            location: location,
            courtCost: courtCost,
            notes: notes,
            payers: payers,
            createdByUid: currentUser.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        })
        .then(function (ref) {
          window.location.hash = "#/session/" + encodeURIComponent(ref.id);
        })
        .catch(function (err) {
          console.error(err);
          alert("Could not create session: " + err.message);
          submitBtn.disabled = false;
        });
    });
  }

  // ---------------------------------------------------------------
  // Session detail
  // ---------------------------------------------------------------
  function renderSessionDetail(sessionId) {
    const tpl = document.getElementById("tpl-session-detail");
    appEl.innerHTML = "";
    appEl.appendChild(tpl.content.cloneNode(true));
    appEl.querySelector(".session-title").textContent = "Loading…";

    unsubscribeSessionDetail = db.collection("sessions").doc(sessionId).onSnapshot(
      function (doc) {
        if (!doc.exists) {
          appEl.innerHTML = '<div class="error-banner">Session not found. It may have been deleted.</div><a href="#/">&larr; Back</a>';
          return;
        }
        latestSession = Object.assign({ id: doc.id }, doc.data());
        paintSessionDetail();
      },
      function (err) {
        console.error(err);
        appEl.innerHTML = '<div class="error-banner">Could not load session: ' + escapeHtml(err.message) + "</div>";
      }
    );

    unsubscribeParticipants = db.collection("sessions").doc(sessionId).collection("participants").onSnapshot(
      function (snap) {
        latestParticipants = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        paintSessionDetail();
      },
      function (err) { console.error("participants listener error", err); }
    );
  }

  function paintSessionDetail() {
    if (!latestSession) return;
    const session = Object.assign({}, latestSession, { participants: latestParticipants });

    appEl.querySelector(".session-title").textContent = formatDate(session.date);
    appEl.querySelector(".session-sub").textContent = session.location || "";
    const notesEl = appEl.querySelector(".session-notes");
    notesEl.textContent = session.notes || "";
    notesEl.style.display = session.notes ? "" : "none";

    const costPerPerson = SplitLogic.computeCostPerPerson(session);
    appEl.querySelector(".stat-cost").textContent = "£" + money(session.courtCost);
    appEl.querySelector(".stat-per-person").textContent = "£" + money(costPerPerson);
    appEl.querySelector(".stat-count").textContent = session.participants.length;

    const payersSummary = appEl.querySelector(".payers-summary-list");
    payersSummary.textContent = (session.payers || [])
      .map(function (p) { return p.name + " (£" + money(p.amountPaid) + ")"; })
      .join(", ") || "no one yet";

    // Participant list
    const listEl = document.getElementById("participant-list");
    listEl.innerHTML = "";
    if (!session.participants.length) {
      listEl.innerHTML = '<li class="empty-state" style="padding:8px 0;">No one has joined yet — be the first!</li>';
    }
    const payerIds = (session.payers || []).map(function (p) { return p.playerId; });
    session.participants.forEach(function (p) {
      const tpl = document.getElementById("tpl-participant-row");
      const node = tpl.content.cloneNode(true);
      node.querySelector(".participant-name").textContent = p.name;
      const tags = node.querySelector(".participant-tags");
      tags.textContent = payerIds.indexOf(p.playerId) !== -1 ? "booked the court" : "";

      const isMe = currentPlayer && p.playerId === currentPlayer.id;
      if (isMe) {
        const cb = node.querySelector(".settled-checkbox");
        cb.checked = !!p.hasSettled;
        cb.addEventListener("change", function () { toggleMySettled(session.id, cb.checked); });
      } else {
        const toggleLabel = node.querySelector(".settled-toggle");
        const span = document.createElement("span");
        span.className = "settled-status" + (p.hasSettled ? " is-paid" : "");
        span.textContent = p.hasSettled ? "paid ✓" : "not paid yet";
        toggleLabel.replaceWith(span);
      }
      listEl.appendChild(node);
    });

    // Join area
    const joinArea = document.getElementById("join-area");
    const alreadyIn = currentPlayer && session.participants.some(function (p) { return p.playerId === currentPlayer.id; });
    if (!currentPlayer) {
      joinArea.innerHTML = "";
    } else if (alreadyIn) {
      joinArea.innerHTML = '<p class="joined-note">✓ You\'re in this session as <strong>' + escapeHtml(currentPlayer.name) + "</strong>.</p>";
    } else {
      joinArea.innerHTML = '<button id="join-btn" class="btn btn-primary">Join as ' + escapeHtml(currentPlayer.name) + "</button>";
      document.getElementById("join-btn").addEventListener("click", function () {
        this.disabled = true;
        joinSession(session.id).catch(function (err) {
          console.error(err);
          alert("Could not join: " + err.message);
        });
      });
    }

    // Settle up
    const settleBtn = document.getElementById("settle-btn");
    const settleResult = document.getElementById("settle-result");
    settleBtn.onclick = function () { renderSettlement(session, settleResult); };
    if (settleResult.dataset.shown === "1") renderSettlement(session, settleResult);
  }

  function renderSettlement(session, container) {
    container.dataset.shown = "1";
    const transfers = SplitLogic.computeSettlement(session);
    const playerById = {};
    allPlayers.forEach(function (p) { playerById[p.id] = p; });

    if (!transfers.length) {
      const hasParticipants = session.participants.length > 0;
      container.innerHTML = '<p class="settle-empty">' +
        (hasParticipants ? "Everyone is settled up. 🎉" : "No one has joined this session yet.") +
        "</p>";
      return;
    }

    container.innerHTML = "";
    transfers.forEach(function (t) {
      const tpl = document.getElementById("tpl-settle-transfer");
      const node = tpl.content.cloneNode(true);
      node.querySelector(".transfer-from").textContent = t.from;
      node.querySelector(".transfer-to").textContent = t.to;
      node.querySelector(".transfer-amount").textContent = "£" + money(t.amount);
      const toPlayer = playerById[t.toId];
      const payInfoEl = node.querySelector(".transfer-payinfo");
      payInfoEl.textContent = toPlayer && toPlayer.paymentInfo ? "Pay " + t.to + " via: " + toPlayer.paymentInfo : "";
      container.appendChild(node);
    });
  }

  function joinSession(sessionId) {
    if (!currentPlayer) return Promise.reject(new Error("Not signed in"));
    const ref = db.collection("sessions").doc(sessionId).collection("participants").doc(currentPlayer.id);
    return ref.get().then(function (doc) {
      if (doc.exists) return; // already joined, nothing to do
      return ref.set({
        playerId: currentPlayer.id,
        name: currentPlayer.name,
        hasSettled: false,
        joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  }

  function toggleMySettled(sessionId, hasSettled) {
    if (!currentPlayer) return;
    return db.collection("sessions").doc(sessionId).collection("participants").doc(currentPlayer.id)
      .update({ hasSettled: hasSettled })
      .catch(function (err) {
        console.error(err);
        alert("Could not update: " + err.message);
      });
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  boot();
})();
