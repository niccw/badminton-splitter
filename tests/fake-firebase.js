// In-memory stand-in for the slice of the Firebase compat SDK (Auth +
// Firestore, including subcollections) that app.js actually uses. Only
// used by the Playwright smoke test — never shipped to users. Does NOT
// enforce firestore.rules (that's Google's server, not testable here);
// it only exercises that the app's own logic behaves given honest data.
(function () {
  const state = {}; // path -> { docId: data }
  const listeners = {}; // path -> { collection: [{cb, filters, orderBy}], docs: {id:[cb]} }
  let idCounter = 1;

  function bucket(path) {
    if (!state[path]) state[path] = {};
    if (!listeners[path]) listeners[path] = { collection: [], docs: {} };
    return { data: state[path], l: listeners[path] };
  }

  function matchesFilters(docData, filters) {
    return (filters || []).every(function (f) {
      const val = docData[f.field];
      if (f.op === "==") return val === f.value || (val === undefined && f.value === null);
      return true;
    });
  }

  function makeCollectionSnapshot(path, filters, orderByField) {
    const { data } = bucket(path);
    let ids = Object.keys(data).filter(function (id) { return matchesFilters(data[id], filters); });
    if (orderByField) {
      ids.sort(function (a, b) {
        const av = data[a][orderByField.field];
        const bv = data[b][orderByField.field];
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return orderByField.dir === "desc" ? -cmp : cmp;
      });
    }
    return {
      empty: ids.length === 0,
      docs: ids.map(function (id) {
        return { id: id, data: function () { return Object.assign({}, data[id]); } };
      }),
    };
  }
  function makeDocSnapshot(path, id) {
    const { data } = bucket(path);
    const exists = Object.prototype.hasOwnProperty.call(data, id);
    return { exists: exists, id: id, data: function () { return Object.assign({}, data[id]); } };
  }
  function notifyCollection(path) {
    bucket(path).l.collection.forEach(function (entry) {
      entry.cb(makeCollectionSnapshot(path, entry.filters, entry.orderBy));
    });
  }
  function notifyDoc(path, id) {
    (bucket(path).l.docs[id] || []).forEach(function (cb) { cb(makeDocSnapshot(path, id)); });
  }

  function queryRef(path, filters, orderByField) {
    return {
      where: function (field, op, value) {
        return queryRef(path, (filters || []).concat([{ field: field, op: op, value: value }]), orderByField);
      },
      orderBy: function (field, dir) {
        return queryRef(path, filters, { field: field, dir: dir || "asc" });
      },
      limit: function () { return queryRef(path, filters, orderByField); },
      get: function () { return Promise.resolve(makeCollectionSnapshot(path, filters, orderByField)); },
      onSnapshot: function (cb) {
        const entry = { cb: cb, filters: filters, orderBy: orderByField };
        bucket(path).l.collection.push(entry);
        cb(makeCollectionSnapshot(path, filters, orderByField));
        return function unsubscribe() {
          const arr = bucket(path).l.collection;
          const idx = arr.indexOf(entry);
          if (idx !== -1) arr.splice(idx, 1);
        };
      },
      add: function (docData) {
        const id = "id" + idCounter++;
        bucket(path).data[id] = Object.assign({}, docData);
        notifyCollection(path);
        return Promise.resolve({ id: id });
      },
      doc: function (id) {
        return docRef(path, id);
      },
    };
  }

  function docRef(path, id) {
    const fullPath = path + "/" + id;
    return {
      id: id,
      _path: fullPath,
      collection: function (sub) { return queryRef(fullPath + "/" + sub); },
      get: function () { return Promise.resolve(makeDocSnapshot(path, id)); },
      set: function (docData) {
        bucket(path).data[id] = Object.assign({}, docData);
        notifyCollection(path);
        notifyDoc(path, id);
        return Promise.resolve();
      },
      update: function (partial) {
        if (!bucket(path).data[id]) return Promise.reject(new Error("not found: " + fullPath));
        Object.assign(bucket(path).data[id], partial);
        notifyCollection(path);
        notifyDoc(path, id);
        return Promise.resolve();
      },
      onSnapshot: function (cb) {
        if (!bucket(path).l.docs[id]) bucket(path).l.docs[id] = [];
        bucket(path).l.docs[id].push(cb);
        cb(makeDocSnapshot(path, id));
        return function unsubscribe() {
          const arr = bucket(path).l.docs[id];
          const idx = arr.indexOf(cb);
          if (idx !== -1) arr.splice(idx, 1);
        };
      },
    };
  }

  const db = {
    collection: function (name) { return queryRef(name); },
    runTransaction: function (fn) {
      // Not used by the current app.js (join/settle use plain get+set),
      // kept as a thin passthrough in case that changes.
      const tx = {
        get: function (ref) { return ref.get(); },
        update: function (ref, data) { ref.update(data); },
        set: function (ref, data) { ref.set(data); },
      };
      return Promise.resolve(fn(tx));
    },
  };

  // --- fake auth ---
  const FAKE_USER = { uid: "test-uid-1", displayName: "Alice Test", email: "alice@example.test", photoURL: null };
  let authListeners = [];
  let currentAuthUser = null;
  const authObj = {
    get currentUser() { return currentAuthUser; },
    onAuthStateChanged: function (cb) {
      authListeners.push(cb);
      cb(currentAuthUser);
      return function unsubscribe() {
        const idx = authListeners.indexOf(cb);
        if (idx !== -1) authListeners.splice(idx, 1);
      };
    },
    signInWithPopup: function () {
      currentAuthUser = FAKE_USER;
      authListeners.forEach(function (cb) { cb(currentAuthUser); });
      return Promise.resolve({ user: currentAuthUser });
    },
    signOut: function () {
      currentAuthUser = null;
      authListeners.forEach(function (cb) { cb(null); });
      return Promise.resolve();
    },
  };

  window.firebase = {
    initializeApp: function () {},
    firestore: function () { return db; },
    auth: function () { return authObj; },
  };
  window.firebase.firestore.FieldValue = { serverTimestamp: function () { return new Date().toISOString(); } };
  window.firebase.auth.GoogleAuthProvider = function () {};

  window.__fakeState = state;
  window.__fakeAuth = { setUser: function (u) { currentAuthUser = u; authListeners.forEach(function (cb) { cb(u); }); } };
})();
