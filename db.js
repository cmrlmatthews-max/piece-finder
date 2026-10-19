window.PF = window.PF || {};

// db.js - storage for Piece Finder.
//   PF.db       IndexedDB database "piecefinder" (version 1): stores groups, pieces, meta.
//   PF.settings small settings object kept in localStorage under "pf.settings".
// Everything is wrapped in Promises. Written for iOS Safari 17, which can drop an IndexedDB
// connection while the app is in the background, so every call can retry once on a fresh connection.
(function () {
  'use strict';

  const DB_NAME = 'piecefinder';
  const DB_VERSION = 1;
  const STORES = ['groups', 'pieces', 'meta'];
  const SETTINGS_KEY = 'pf.settings';
  const DEFAULT_SETTINGS = { apiKey: '', model: 'claude-haiku-5-5', topN: 8 };

  let dbPromise = null; // cached promise returned by open()
  let dbConn = null; // the connection that promise resolved to

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  // Closes a connection and forgets it, so the next open() makes a fresh one.
  function dropConnection(db) {
    try {
      db.close();
    } catch (e) {
      /* already closed */
    }
    if (dbConn === db) {
      dbConn = null;
      dbPromise = null;
    }
  }

  // Makes sure one store exists (with its keyPath) and has plain indexes named after their fields.
  function ensureStore(db, tx, name, keyPath, indexes) {
    const store = db.objectStoreNames.contains(name)
      ? tx.objectStore(name)
      : db.createObjectStore(name, { keyPath: keyPath });
    indexes.forEach(function (field) {
      if (!store.indexNames.contains(field)) store.createIndex(field, field, { unique: false });
    });
  }

  // Version 1 schema: groups, pieces (indexes groupId + status), meta.
  function createSchema(db, tx) {
    ensureStore(db, tx, 'groups', 'id', []);
    ensureStore(db, tx, 'pieces', 'id', ['groupId', 'status']);
    ensureStore(db, tx, 'meta', 'key', []);
  }

  // Opens the database once and caches the promise. A failed open is not cached, so a later call can retry.
  function open() {
    if (dbPromise) return dbPromise;
    const p = new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('This browser cannot save data on the phone.'));
        return;
      }
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }
      req.onupgradeneeded = function () {
        createSchema(req.result, req.transaction);
      };
      req.onblocked = function () {
        // Another tab still holds an older connection. Release ours so the open can go ahead.
        if (dbConn) dropConnection(dbConn);
        console.warn('piecefinder: database open is waiting for another tab to let go');
      };
      req.onerror = function () {
        reject(req.error || new Error('Could not open the database.'));
      };
      req.onsuccess = function () {
        const db = req.result;
        // Another tab wants to upgrade or delete the database: step aside.
        db.onversionchange = function () {
          dropConnection(db);
        };
        // The browser closed the connection on its own (storage cleared, app suspended): reopen next time.
        db.onclose = function () {
          dropConnection(db);
        };
        dbConn = db;
        resolve(db);
      };
    });
    dbPromise = p;
    p.catch(function () {
      if (dbPromise === p) dbPromise = null;
    });
    return p;
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  // Turns a storage-full error into a message a person can act on; other errors pass through unchanged.
  function friendlyError(err) {
    if (err && err.name === 'QuotaExceededError') {
      const e = new Error('The phone is out of storage space. Free some space and try again.');
      e.name = 'QuotaExceededError';
      e.cause = err;
      return e;
    }
    return err || new Error('Database error.');
  }

  // True for the errors Safari raises when a connection died in the background.
  function isStaleConnection(err) {
    return !!err && (err.name === 'InvalidStateError' || err.name === 'UnknownError');
  }

  // Starts one transaction on `db` and calls work(tx), which issues the requests and may return one IDBRequest.
  // Resolves with that request's result AFTER the transaction has committed. Rejects if it aborts.
  function startTx(db, names, mode, work) {
    return new Promise(function (resolve, reject) {
      let tx;
      let req = null;
      try {
        tx = db.transaction(names, mode);
      } catch (e) {
        reject(e);
        return;
      }
      tx.oncomplete = function () {
        resolve(req ? req.result : undefined);
      };
      tx.onabort = function () {
        reject(friendlyError(tx.error));
      };
      try {
        req = work(tx) || null;
      } catch (e) {
        reject(friendlyError(e));
        try {
          tx.abort();
        } catch (e2) {
          /* already finished */
        }
      }
    });
  }

  // Runs a transaction on the cached connection. If the connection turns out to be dead, retries once on a new one.
  function run(names, mode, work) {
    return open().then(function (db) {
      return startTx(db, names, mode, work).catch(function (err) {
        if (!isStaleConnection(err)) throw err;
        dropConnection(db);
        return open().then(function (fresh) {
          return startTx(fresh, names, mode, work);
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // PF.db
  // ---------------------------------------------------------------------------

  // Reads one record by primary key. Resolves undefined when it does not exist.
  function get(store, key) {
    return run([store], 'readonly', function (tx) {
      return tx.objectStore(store).get(key);
    });
  }

  // Inserts or replaces one record.
  function put(store, obj) {
    return run([store], 'readwrite', function (tx) {
      tx.objectStore(store).put(obj);
    });
  }

  // Inserts or replaces many records in ONE transaction (all are saved, or none).
  function bulkPut(store, objs) {
    const list = Array.from(objs || []);
    if (!list.length) return Promise.resolve();
    return run([store], 'readwrite', function (tx) {
      const os = tx.objectStore(store);
      list.forEach(function (o) {
        os.put(o);
      });
    });
  }

  // Deletes one record by primary key (no error if it is missing).
  function del(store, key) {
    return run([store], 'readwrite', function (tx) {
      tx.objectStore(store).delete(key);
    });
  }

  // Reads every record of a store.
  function all(store) {
    return run([store], 'readonly', function (tx) {
      return tx.objectStore(store).getAll();
    });
  }

  // Reads every record whose indexed field equals `value`. A null/undefined value matches nothing.
  function byIndex(store, indexName, value) {
    if (value === undefined || value === null) return Promise.resolve([]);
    return run([store], 'readonly', function (tx) {
      return tx.objectStore(store).index(indexName).getAll(value);
    });
  }

  // Deletes a group and all of its pieces in one transaction.
  function deleteGroup(groupId) {
    if (groupId === undefined || groupId === null || groupId === '') {
      return Promise.reject(new Error('deleteGroup needs a group id.'));
    }
    return run(['groups', 'pieces'], 'readwrite', function (tx) {
      const pieces = tx.objectStore('pieces');
      tx.objectStore('groups').delete(groupId);
      const cursorReq = pieces.index('groupId').openKeyCursor(IDBKeyRange.only(groupId));
      cursorReq.onsuccess = function () {
        const cursor = cursorReq.result;
        if (!cursor) return;
        pieces.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }

  // Empties all three stores in one transaction.
  function clearAll() {
    return run(STORES, 'readwrite', function (tx) {
      STORES.forEach(function (name) {
        tx.objectStore(name).clear();
      });
    });
  }

  // Asks the browser not to evict our data. Never throws and never rejects; resolves true/false.
  function requestPersist() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === 'function') {
        return Promise.resolve(navigator.storage.persist()).then(Boolean, function () {
          return false;
        });
      }
    } catch (e) {
      /* fall through */
    }
    return Promise.resolve(false);
  }

  PF.db = {
    open: open,
    get: get,
    put: put,
    bulkPut: bulkPut,
    del: del,
    all: all,
    byIndex: byIndex,
    deleteGroup: deleteGroup,
    clearAll: clearAll,
    requestPersist: requestPersist
  };

  // ---------------------------------------------------------------------------
  // PF.settings  (localStorage, JSON)
  // ---------------------------------------------------------------------------

  let settingsFallback = null; // JSON text kept in memory only if localStorage refuses to save

  // Reads the saved settings text, or null if there is none or storage is blocked.
  function readSettingsText() {
    if (settingsFallback !== null) return settingsFallback;
    try {
      return window.localStorage.getItem(SETTINGS_KEY);
    } catch (e) {
      return null;
    }
  }

  // Saves the settings text. If localStorage fails (private mode, quota), keeps it in memory for this session.
  function writeSettingsText(text) {
    try {
      window.localStorage.setItem(SETTINGS_KEY, text);
      settingsFallback = null;
    } catch (e) {
      settingsFallback = text;
    }
  }

  // Makes sure the known keys have the right types; anything unusable falls back to its default.
  function cleanSettings(s) {
    if (typeof s.apiKey !== 'string') s.apiKey = DEFAULT_SETTINGS.apiKey;
    if (typeof s.model !== 'string' || !s.model) s.model = DEFAULT_SETTINGS.model;
    const n = Number(s.topN);
    s.topN = Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SETTINGS.topN;
    return s;
  }

  // Returns the saved settings merged over the defaults (always a fresh object).
  function getSettings() {
    let saved = {};
    try {
      const text = readSettingsText();
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
    } catch (e) {
      saved = {}; // corrupt JSON: start from the defaults
    }
    return cleanSettings(Object.assign({}, DEFAULT_SETTINGS, saved));
  }

  // Merges `partial` into the saved settings, saves, and returns the new settings.
  // Keys with an undefined value are ignored. The API key is trimmed (pasted keys often carry a space or newline).
  function setSettings(partial) {
    const next = getSettings();
    if (partial && typeof partial === 'object') {
      Object.keys(partial).forEach(function (k) {
        if (partial[k] !== undefined) next[k] = partial[k];
      });
    }
    if (typeof next.apiKey === 'string') next.apiKey = next.apiKey.trim();
    writeSettingsText(JSON.stringify(cleanSettings(next)));
    return getSettings();
  }

  PF.settings = {
    get: getSettings,
    set: setSettings
  };
})();
