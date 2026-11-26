/* Library Reader — IndexedDB adapter (browser only).
 *
 * Two object stores in database 'library-reader-v1':
 *   pdfs  — keyPath 'id' — {id, blob} — the PDF bytes themselves.
 *   pages — keyPath ['bookId', 'page'] — {bookId, page, text} —
 *           the extracted text of one page, so a re-opened book
 *           does not have to re-index.
 * Nothing here leaves the device. Deleting a book's data removes
 * its PDF blob and every indexed page for it.
 */
(function (root) {
  'use strict';

  var DB_NAME = 'library-reader-v1';
  var DB_VERSION = 1;

  var dbPromise = null;
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('pdfs')) {
          db.createObjectStore('pdfs', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('pages')) {
          db.createObjectStore('pages', { keyPath: ['bookId', 'page'] });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('database is blocked')); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var result;
        try { result = fn(s); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }

  function requestAsPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var api = {
    putPdf: function (id, blob) {
      return tx('pdfs', 'readwrite', function (s) {
        return requestAsPromise(s.put({ id: id, blob: blob }));
      });
    },
    getPdf: function (id) {
      return tx('pdfs', 'readonly', function (s) {
        return requestAsPromise(s.get(id)).then(function (rec) {
          return rec ? rec.blob : null;
        });
      });
    },
    putPageText: function (bookId, page, text) {
      return tx('pages', 'readwrite', function (s) {
        return requestAsPromise(s.put({ bookId: bookId, page: page, text: text }));
      });
    },
    getPageTexts: function (bookId) {
      return tx('pages', 'readonly', function (s) {
        var range = IDBKeyRange.bound([bookId, 0], [bookId, Number.MAX_SAFE_INTEGER]);
        return requestAsPromise(s.getAll(range)).then(function (rows) {
          var out = {};
          (rows || []).forEach(function (r) { out[r.page] = r.text; });
          return out;
        });
      });
    },
    deleteBookData: function (id) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction(['pdfs', 'pages'], 'readwrite');
          t.objectStore('pdfs').delete(id);
          var range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
          t.objectStore('pages').delete(range);
          t.oncomplete = function () { resolve(true); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
        });
      });
    }
  };

  root.LR_IDB = api;
})(typeof window !== 'undefined' ? window : globalThis);
