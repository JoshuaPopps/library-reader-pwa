/* Library Reader PWA — bring your own manual.
 *
 * No build step, no dependencies at runtime beyond the vendored
 * pdf.js (see vendor/), no account, no server. The user loads their
 * own PDF files on-device; the PDF bytes never leave the device.
 * Nothing is shipped with the app — no manuals, no book content.
 * The only document the app can create by itself is the example
 * document, generated on the device by buildExamplePdf(), clearly
 * labeled as an example, with text that only describes the reader.
 *
 * Rendering approach: pdf.js 3.11.174 (Mozilla, Apache 2.0), VENDORED
 * in vendor/ — the app loads no CDN at runtime. pdf.js is the only
 * approach that gives both page rendering AND in-document text search
 * fully offline: the browser's built-in PDF viewer cannot be searched
 * from the page and behaves inconsistently inside an installed PWA,
 * and a hand-rolled PDF text extractor fails on real manuals
 * (FlateDecode streams, custom font encodings, ToUnicode maps).
 * The worker (vendor/pdf.worker.min.js) does the parsing off the
 * main thread; the text layer makes the rendered page selectable.
 *
 * Storage, two layers:
 *   - localStorage key 'library-reader-v1': book metadata (title,
 *     file name, size, page count, last page), bookmarks, notes.
 *     Small JSON, sync, same pattern as the other Pocket Garage apps.
 *   - IndexedDB database 'library-reader-v1': the PDF blobs
 *     themselves (store 'pdfs') and the per-page extracted text
 *     (store 'pages') so a re-opened book does not re-index.
 *     Browser-only, in idb.js (window.LR_IDB); the pure logic below
 *     never touches it and is tested in Node with a memory adapter.
 *
 * Honesty rules, printed wherever the figures appear:
 *   - Every title, page count, bookmark, and note is either typed in
 *     by the reader or read from a file the reader loaded.
 *   - The backup is metadata only — bookmarks and notes. The PDFs
 *     are not in it; load them again on a new device, then import.
 *   - A book with the same title and size as one already in the
 *     library is refused as a duplicate — load it once.
 */
'use strict';

var STORAGE_KEY = 'library-reader-v1';
var VERSION = 1;
var EXAMPLE_TITLE = 'Example document — try the reader';
var EXAMPLE_FILENAME = 'example-document.pdf';
var MIN_SEARCH_LEN = 2;
var MAX_SEARCH_RESULTS = 50;

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

function isPdfBytes(bytes) {
  /* First five bytes must be %PDF-. Accepts a Uint8Array (or any
   * array-like of numbers). Anything else is not a PDF. */
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 &&
    bytes[3] === 0x46 && bytes[4] === 0x2D;
}

function fmtSize(bytes) {
  if (typeof bytes !== 'number' || !(bytes >= 0)) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function fmtDateUTC(ts) {
  /* YYYY-MM-DD in UTC — deterministic, no timezone drift in tests. */
  var d = new Date(ts);
  if (isNaN(d.getTime())) return '—';
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPosInt(v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 1;
}

function mintId(items, prefix) {
  /* Highest numeric suffix in use + 1 — same rule as the bike log:
   * ids are never reused while in use, and a deleted id stays spent
   * only until a higher one exists; the next id is always fresh. */
  var max = 0;
  (items || []).forEach(function (it) {
    if (it && typeof it.id === 'string') {
      var m = new RegExp('^' + prefix + '(\\d+)$').exec(it.id);
      if (m && +m[1] > max) max = +m[1];
    }
  });
  return prefix + (max + 1);
}

function emptyState() {
  return { version: VERSION, books: [], bookmarks: [], notes: [] };
}

function findBook(state, id) {
  if (!state || !Array.isArray(state.books)) return null;
  for (var i = 0; i < state.books.length; i++) {
    if (state.books[i].id === id) return state.books[i];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Example PDF — generated on the device, no content shipped           */
/* ------------------------------------------------------------------ */

/* The example document is three pages of instructions about the
 * reader itself. It is built byte by byte here, with a correct xref
 * table, so it opens in any PDF reader. All strings are plain ASCII;
 * escapePdfString strips anything else to '?'. */
var EXAMPLE_PAGES = [
  {
    title: 'Example document',
    lines: [
      'This file was made on your device by the Library Reader',
      'so you can try it out. It is not a real manual — it only',
      'describes how the reader works.',
      '',
      'How to use this reader:',
      '- Library tab: pick a PDF file from your device to add it.',
      '  The file is stored on this device only. It is never',
      '  uploaded, and it never leaves the device.',
      '- Tap a book to open it. Swipe or use the page buttons.',
      '- The reader remembers the page you left off.',
      '',
      'Nothing in this example came from a book or a manual.'
    ]
  },
  {
    title: 'Searching',
    lines: [
      'Type words in the search box on the Reader tab.',
      'The reader looks through the pages it has indexed —',
      'indexing runs in the background while you read, so a',
      'long manual takes a little while before every page',
      'is searchable. The result list shows the page and',
      'the sentence the words appear in. Tap a result to',
      'jump to that page.',
      '',
      'Search is case-insensitive and matches whole words',
      'and parts of words. Two letters or more, please.'
    ]
  },
  {
    title: 'Your files stay yours',
    lines: [
      'Bookmarks and notes live on the Notes tab, grouped',
      'by book. A bookmark is a page with a label; a note',
      'is a few words of your own on a page.',
      '',
      'The Data tab exports your bookmarks and notes as',
      'one JSON file. The PDFs themselves are not in the',
      'backup — load them again on a new device, then',
      'import, and the bookmarks find their books again.',
      '',
      'The reader works offline after install. No account,',
      'no server, no sync. What you load stays on the',
      'device it was loaded on.'
    ]
  }
];

function escapePdfString(s) {
  /* PDF literal-string escaping: backslash, parens. Anything outside
   * printable ASCII becomes '?' — the example text is ASCII anyway. */
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c === 0x5C) out += '\\\\';
    else if (c === 0x28) out += '\\(';
    else if (c === 0x29) out += '\\)';
    else if (c < 0x20 || c > 0x7E) out += '?';
    else out += s[i];
  }
  return out;
}

function buildExamplePdf() {
  /* Returns a Uint8Array holding a valid 3-page PDF. Objects:
   *   1 catalog, 2 pages, 3 page-1, 4 font F1 (Helvetica),
   *   5 font F2 (Helvetica-Bold), 6 content-1, 7 page-2,
   *   8 content-2, 9 page-3, 10 content-3. */
  var chunks = [];
  var offsets = [0]; /* offsets[objectNumber] = byte offset of "N 0 obj" */
  var enc = new TextEncoder();
  var len = 0;
  function push(s) {
    chunks.push(s);
    len += enc.encode(s).length;
  }
  function obj(n, body) {
    offsets[n] = len;
    push(n + ' 0 obj\n' + body + '\nendobj\n');
  }
  function contentStream(lines) {
    var s = '';
    var y = 740;
    s += 'BT /F2 20 Tf 72 ' + y + ' Td (' + escapePdfString(lines.title) + ') Tj ET\n';
    y -= 34;
    for (var i = 0; i < lines.lines.length; i++) {
      var t = lines.lines[i];
      if (t === '') { y -= 20; continue; }
      s += 'BT /F1 12 Tf 72 ' + y + ' Td (' + escapePdfString(t) + ') Tj ET\n';
      y -= 20;
    }
    return s;
  }
  function streamObj(n, data) {
    offsets[n] = len;
    var bytes = enc.encode(data).length;
    push(n + ' 0 obj\n<< /Length ' + bytes + ' >>\nstream\n' + data + '\nendstream\nendobj\n');
  }

  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R 7 0 R 9 0 R] /Count 3 >>');
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  streamObj(6, contentStream(EXAMPLE_PAGES[0]));
  obj(7, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 8 0 R >>');
  streamObj(8, contentStream(EXAMPLE_PAGES[1]));
  obj(9, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
    '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 10 0 R >>');
  streamObj(10, contentStream(EXAMPLE_PAGES[2]));

  var xrefPos = len;
  var total = 11; /* objects 0..10 */
  var xref = 'xref\n0 ' + total + '\n';
  xref += '0000000000 65535 f \n';
  for (var n = 1; n < total; n++) {
    var off = String(offsets[n]);
    while (off.length < 10) off = '0' + off;
    xref += off + ' 00000 n \n';
  }
  push(xref);
  push('trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');

  var out = new Uint8Array(len);
  var pos = 0;
  chunks.forEach(function (c) {
    var b = enc.encode(c);
    out.set(b, pos);
    pos += b.length;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Search — pure, over a {pageNumber: text} map                        */
/* ------------------------------------------------------------------ */

function countOccurrences(text, needle) {
  if (!text || !needle) return 0;
  var hay = text.toLowerCase();
  var n = needle.toLowerCase();
  var count = 0;
  var at = 0;
  while (true) {
    var i = hay.indexOf(n, at);
    if (i < 0) break;
    count++;
    at = i + n.length;
  }
  return count;
}

function snippetFor(text, query) {
  /* Returns {before, match, after} around the first occurrence, or
   * null when there is no occurrence. Context is ~45 characters
   * each side, cut at word boundaries where the cut would land
   * mid-word. The DOM layer wraps match in <mark>. */
  var idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return null;
  var start = Math.max(0, idx - 45);
  var end = Math.min(text.length, idx + query.length + 45);
  var before = text.slice(start, idx);
  var after = text.slice(idx + query.length, end);
  if (start > 0) {
    var sp = before.indexOf(' ');
    before = (sp >= 0 ? before.slice(sp + 1) : '');
    before = '…' + before;
  }
  if (end < text.length) {
    var sp2 = after.lastIndexOf(' ');
    after = (sp2 >= 0 ? after.slice(0, sp2) : after) + '…';
  }
  return { before: before, match: text.slice(idx, idx + query.length), after: after };
}

function searchPages(pageTexts, query) {
  /* pageTexts: {pageNumber: text}. Returns results ranked by
   * occurrence count (most first), then page number ascending,
   * capped at MAX_SEARCH_RESULTS. A query shorter than
   * MIN_SEARCH_LEN returns no results — the UI says so. */
  var q = (query || '').trim();
  if (q.length < MIN_SEARCH_LEN) return [];
  var results = [];
  Object.keys(pageTexts || {}).forEach(function (k) {
    var page = +k;
    var text = pageTexts[k] || '';
    var count = countOccurrences(text, q);
    if (count > 0) {
      results.push({ page: page, count: count, snippet: snippetFor(text, q) });
    }
  });
  results.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return a.page - b.page;
  });
  return results.slice(0, MAX_SEARCH_RESULTS);
}

/* ------------------------------------------------------------------ */
/* State — books, bookmarks, notes (pure; storage adapter outside)     */
/* ------------------------------------------------------------------ */

function validateBookFields(f) {
  f = f || {};
  if (!isNonEmptyString(f.title)) throw new Error('a title is required');
  if (!isNonEmptyString(f.fileName)) throw new Error('a file name is required');
  if (typeof f.size !== 'number' || !(f.size > 0) || Math.floor(f.size) !== f.size) {
    throw new Error('file size must be a whole number of bytes above 0');
  }
  if (!isPosInt(f.pageCount)) throw new Error('page count must be 1 or more');
  return {
    title: f.title.trim(),
    fileName: f.fileName,
    size: f.size,
    pageCount: f.pageCount,
    addedAt: typeof f.addedAt === 'number' ? f.addedAt : Date.now(),
    lastPage: isPosInt(f.lastPage) ? Math.min(f.lastPage, f.pageCount) : 1
  };
}

function addBook(state, fields) {
  var book = validateBookFields(fields);
  var dup = (state.books || []).some(function (b) {
    return b.title === book.title && b.size === book.size;
  });
  if (dup) throw new Error('"' + book.title + '" is already in the library');
  book.id = mintId(state.books, 'bk');
  state.books.push(book);
  return book;
}

function renameBook(state, id, title) {
  var book = findBook(state, id);
  if (!book) throw new Error('no such book');
  if (!isNonEmptyString(title)) throw new Error('a title is required');
  var t = title.trim();
  var dup = state.books.some(function (b) {
    return b.id !== id && b.title === t && b.size === book.size;
  });
  if (dup) throw new Error('"' + t + '" is already in the library');
  book.title = t;
  return book;
}

function removeBook(state, id) {
  /* Removes the book and its bookmarks and notes. The PDF blob and
   * the indexed page texts live in IndexedDB and are removed by the
   * browser layer (LR_IDB.deleteBookData) — this function only ever
   * touches the JSON state. */
  var idx = -1;
  for (var i = 0; i < state.books.length; i++) {
    if (state.books[i].id === id) { idx = i; break; }
  }
  if (idx < 0) throw new Error('no such book');
  state.books.splice(idx, 1);
  state.bookmarks = state.bookmarks.filter(function (b) { return b.bookId !== id; });
  state.notes = state.notes.filter(function (n) { return n.bookId !== id; });
}

function setLastPage(state, id, page) {
  var book = findBook(state, id);
  if (!book) throw new Error('no such book');
  if (!isPosInt(page) || page > book.pageCount) {
    throw new Error('page must be between 1 and ' + book.pageCount);
  }
  book.lastPage = page;
  return book;
}

function addBookmark(state, fields) {
  fields = fields || {};
  var book = findBook(state, fields.bookId);
  if (!book) throw new Error('no such book');
  if (!isPosInt(fields.page) || fields.page > book.pageCount) {
    throw new Error('page must be between 1 and ' + book.pageCount);
  }
  var label = isNonEmptyString(fields.label) ? fields.label.trim() : 'Page ' + fields.page;
  var bm = {
    id: mintId(state.bookmarks, 'bm'),
    bookId: fields.bookId,
    page: fields.page,
    label: label,
    createdAt: typeof fields.createdAt === 'number' ? fields.createdAt : Date.now()
  };
  state.bookmarks.push(bm);
  return bm;
}

function removeBookmark(state, id) {
  var idx = -1;
  for (var i = 0; i < state.bookmarks.length; i++) {
    if (state.bookmarks[i].id === id) { idx = i; break; }
  }
  if (idx < 0) throw new Error('no such bookmark');
  state.bookmarks.splice(idx, 1);
}

function addNote(state, fields) {
  fields = fields || {};
  var book = findBook(state, fields.bookId);
  if (!book) throw new Error('no such book');
  if (!isPosInt(fields.page) || fields.page > book.pageCount) {
    throw new Error('page must be between 1 and ' + book.pageCount);
  }
  if (!isNonEmptyString(fields.text)) throw new Error('a note needs some words in it');
  var note = {
    id: mintId(state.notes, 'nt'),
    bookId: fields.bookId,
    page: fields.page,
    text: fields.text.trim(),
    createdAt: typeof fields.createdAt === 'number' ? fields.createdAt : Date.now()
  };
  state.notes.push(note);
  return note;
}

function updateNote(state, id, text) {
  if (!isNonEmptyString(text)) throw new Error('a note needs some words in it');
  for (var i = 0; i < state.notes.length; i++) {
    if (state.notes[i].id === id) {
      state.notes[i].text = text.trim();
      return state.notes[i];
    }
  }
  throw new Error('no such note');
}

function removeNote(state, id) {
  var idx = -1;
  for (var i = 0; i < state.notes.length; i++) {
    if (state.notes[i].id === id) { idx = i; break; }
  }
  if (idx < 0) throw new Error('no such note');
  state.notes.splice(idx, 1);
}

function counts(state) {
  var pages = 0;
  var bytes = 0;
  (state.books || []).forEach(function (b) {
    pages += b.pageCount || 0;
    bytes += b.size || 0;
  });
  return {
    books: (state.books || []).length,
    pages: pages,
    bookmarks: (state.bookmarks || []).length,
    notes: (state.notes || []).length,
    bytes: bytes
  };
}

/* ------------------------------------------------------------------ */
/* Export / import — metadata only, never the PDFs                     */
/* ------------------------------------------------------------------ */

function exportState(state) {
  /* The backup is the whole library's metadata: every book (title,
   * file name, size, page count — NO file bytes), every bookmark,
   * every note. Bookmarks and notes point at books by id inside
   * this file; on import they are matched to the books actually
   * in the library by title and size. */
  return {
    app: 'library-reader-pwa',
    version: VERSION,
    exportedAt: new Date().toISOString(),
    books: (state.books || []).map(function (b) {
      return {
        id: b.id, title: b.title, fileName: b.fileName,
        size: b.size, pageCount: b.pageCount,
        addedAt: b.addedAt, lastPage: b.lastPage
      };
    }),
    bookmarks: (state.bookmarks || []).map(function (b) {
      return { id: b.id, bookId: b.bookId, page: b.page, label: b.label, createdAt: b.createdAt };
    }),
    notes: (state.notes || []).map(function (n) {
      return { id: n.id, bookId: n.bookId, page: n.page, text: n.text, createdAt: n.createdAt };
    })
  };
}

function importState(state, data) {
  /* Merges an exported file into the current library. Books are
   * never added by an import — their PDFs are not in the backup —
   * so a bookmark or note is applied only when a book with the
   * same title and size is already in this library; the rest are
   * counted as skipped and named in the result, so the reader
   * knows to load those PDFs first and import again. Nothing is
   * ever deleted by an import. */
  if (!data || typeof data !== 'object') throw new Error('that is not a library backup');
  if (data.app !== 'library-reader-pwa') throw new Error('that file is not a Library Reader backup');
  if (!Array.isArray(data.books) || !Array.isArray(data.bookmarks) || !Array.isArray(data.notes)) {
    throw new Error('the backup is missing its books, bookmarks, or notes');
  }
  var byKey = {};
  (state.books || []).forEach(function (b) {
    byKey[b.title + '\u0000' + b.size] = b.id;
  });
  var importedBookIds = {};
  data.books.forEach(function (b) {
    if (b && typeof b.title === 'string' && typeof b.size === 'number') {
      importedBookIds[b.id] = byKey[b.title + '\u0000' + b.size] || null;
    }
  });
  var applied = { bookmarks: 0, notes: 0 };
  var skipped = { bookmarks: 0, notes: 0 };
  var missingBooks = [];
  data.books.forEach(function (b) {
    if (b && typeof b.title === 'string' && !importedBookIds[b.id]) missingBooks.push(b.title);
  });
  (data.bookmarks || []).forEach(function (bm) {
    var localId = bm && importedBookIds[bm.bookId];
    if (!localId || !isPosInt(bm.page)) { skipped.bookmarks++; return; }
    if (state.bookmarks.some(function (x) {
      return x.bookId === localId && x.page === bm.page && x.label === bm.label;
    })) return; /* already here — not a skip, not a re-add */
    addBookmark(state, {
      bookId: localId, page: bm.page,
      label: isNonEmptyString(bm.label) ? bm.label : 'Page ' + bm.page,
      createdAt: typeof bm.createdAt === 'number' ? bm.createdAt : Date.now()
    });
    applied.bookmarks++;
  });
  (data.notes || []).forEach(function (nt) {
    var localId = nt && importedBookIds[nt.bookId];
    if (!localId || !isPosInt(nt.page) || !isNonEmptyString(nt.text)) { skipped.notes++; return; }
    if (state.notes.some(function (x) {
      return x.bookId === localId && x.page === nt.page && x.text === nt.text;
    })) return; /* already here */
    addNote(state, {
      bookId: localId, page: nt.page, text: nt.text,
      createdAt: typeof nt.createdAt === 'number' ? nt.createdAt : Date.now()
    });
    applied.notes++;
  });
  return { applied: applied, skipped: skipped, missingBooks: missingBooks };
}

/* ------------------------------------------------------------------ */
/* Node export (the DOM layer below is browser-only)                   */
/* ------------------------------------------------------------------ */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STORAGE_KEY: STORAGE_KEY,
    VERSION: VERSION,
    EXAMPLE_TITLE: EXAMPLE_TITLE,
    EXAMPLE_FILENAME: EXAMPLE_FILENAME,
    MIN_SEARCH_LEN: MIN_SEARCH_LEN,
    MAX_SEARCH_RESULTS: MAX_SEARCH_RESULTS,
    EXAMPLE_PAGES: EXAMPLE_PAGES,
    isPdfBytes: isPdfBytes,
    fmtSize: fmtSize,
    fmtDateUTC: fmtDateUTC,
    escapePdfString: escapePdfString,
    buildExamplePdf: buildExamplePdf,
    countOccurrences: countOccurrences,
    snippetFor: snippetFor,
    searchPages: searchPages,
    mintId: mintId,
    emptyState: emptyState,
    findBook: findBook,
    validateBookFields: validateBookFields,
    addBook: addBook,
    renameBook: renameBook,
    removeBook: removeBook,
    setLastPage: setLastPage,
    addBookmark: addBookmark,
    removeBookmark: removeBookmark,
    addNote: addNote,
    updateNote: updateNote,
    removeNote: removeNote,
    counts: counts,
    exportState: exportState,
    importState: importState
  };
}

/* ------------------------------------------------------------------ */
/* Browser layer — tabs, library, reader, notes, data                  */
/* ------------------------------------------------------------------ */

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  (function () {
    var pdfjsLib = window.pdfjsLib;
    if (pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }

    /* --- state (localStorage, metadata only) --- */
    var state = emptyState();
    function loadState() {
      try {
        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.books) &&
          Array.isArray(parsed.bookmarks) && Array.isArray(parsed.notes)) {
          state = parsed;
        }
      } catch (e) { /* corrupt state: start empty, leave it alone */ }
    }
    function saveState() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* full: keep going in memory */ }
    }
    loadState();

    /* --- tiny DOM helpers --- */
    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null) n.textContent = text;
      return n;
    }
    function toast(msg) {
      var t = $('toast');
      t.textContent = msg;
      t.classList.add('show');
      clearTimeout(toast._t);
      toast._t = setTimeout(function () { t.classList.remove('show'); }, 4000);
    }
    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /* --- tabs --- */
    var currentView = 'library';
    document.querySelectorAll('.navbtn').forEach(function (btn) {
      btn.addEventListener('click', function () { showView(btn.getAttribute('data-view')); });
    });
    function showView(name) {
      currentView = name;
      document.querySelectorAll('.view').forEach(function (v) {
        v.classList.toggle('active', v.id === 'view-' + name);
      });
      document.querySelectorAll('.navbtn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-view') === name);
      });
      if (name === 'library') renderLibrary();
      if (name === 'notes') renderNotes();
      if (name === 'data') renderData();
      window.scrollTo(0, 0);
    }

    /* --- library tab --- */
    var renameTarget = null;
    function renderLibrary() {
      var list = $('book-list');
      list.innerHTML = '';
      var books = state.books.slice().sort(function (a, b) {
        return a.title.localeCompare(b.title);
      });
      if (!books.length) {
        list.appendChild(el('p', 'muted', 'No books yet — pick a PDF below, or load the example document to try the reader.'));
      }
      books.forEach(function (b) {
        var card = el('div', 'card book-row');
        var h = el('h3', null, b.title);
        card.appendChild(h);
        var meta = el('p', 'muted',
          b.fileName + ' · ' + b.pageCount + ' pages · ' + fmtSize(b.size) +
          ' · added ' + fmtDateUTC(b.addedAt));
        card.appendChild(meta);
        if (b.lastPage > 1) {
          card.appendChild(el('p', 'muted', 'Left off on page ' + b.lastPage + ' of ' + b.pageCount + '.'));
        }
        var row = el('div');
        var openBtn = el('button', 'primary', b.lastPage > 1 ? 'Continue — page ' + b.lastPage : 'Open');
        openBtn.addEventListener('click', function () { openBook(b.id, b.lastPage); });
        row.appendChild(openBtn);
        var renameBtn = el('button', 'secondary', 'Rename');
        renameBtn.addEventListener('click', function () {
          renameTarget = b.id;
          $('rename-title').value = b.title;
          $('rename-form').style.display = 'block';
          $('rename-title').focus();
        });
        row.appendChild(renameBtn);
        var delBtn = el('button', 'danger', 'Delete');
        delBtn.addEventListener('click', function () {
          if (delBtn.getAttribute('data-armed')) {
            deleteBook(b.id);
          } else {
            delBtn.setAttribute('data-armed', '1');
            delBtn.textContent = 'Tap again to confirm';
            setTimeout(function () {
              delBtn.removeAttribute('data-armed');
              delBtn.textContent = 'Delete';
            }, 4000);
          }
        });
        row.appendChild(delBtn);
        card.appendChild(row);
        list.appendChild(card);
      });
      $('rename-form').style.display = 'none';
    }

    async function deleteBook(id) {
      var book = findBook(state, id);
      if (!book) return;
      try { removeBook(state, id); } catch (e) { toast(e.message); return; }
      saveState();
      if (window.LR_IDB) {
        try { await window.LR_IDB.deleteBookData(id); } catch (e) { /* blob already gone */ }
      }
      if (currentBook && currentBook.id === id) closeBook();
      toast('Deleted "' + book.title + '".');
      renderLibrary();
      renderData();
    }

    $('rename-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!renameTarget) return;
      try {
        renameBook(state, renameTarget, $('rename-title').value);
        saveState();
        renameTarget = null;
        renderLibrary();
        toast('Renamed.');
      } catch (err) { toast(err.message); }
    });
    $('rename-cancel').addEventListener('click', function () {
      renameTarget = null;
      $('rename-form').style.display = 'none';
    });

    async function addPdfFile(file) {
      /* Returns 'added' or throws with a plain message. Parses the
       * file with pdf.js first, so a corrupt or non-PDF file is
       * refused before anything is stored. */
      if (!file) throw new Error('no file');
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        throw new Error('"' + file.name + '" is not a PDF file');
      }
      var buf;
      try { buf = await file.arrayBuffer(); } catch (e) { throw new Error('could not read "' + file.name + '"'); }
      if (!isPdfBytes(new Uint8Array(buf, 0, 5))) {
        throw new Error('"' + file.name + '" is not a PDF file');
      }
      var pdf;
      try {
        pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      } catch (e) {
        throw new Error('"' + file.name + '" could not be opened as a PDF');
      }
      var pageCount = pdf.numPages;
      try { await pdf.destroy(); } catch (e) { /* already closed */ }
      var title = file.name.replace(/\.pdf$/i, '');
      var book;
      try {
        book = addBook(state, { title: title, fileName: file.name, size: file.size, pageCount: pageCount });
      } catch (e) { throw e; }
      try {
        await window.LR_IDB.putPdf(book.id, new Blob([buf], { type: 'application/pdf' }));
      } catch (e) {
        removeBook(state, book.id);
        saveState();
        throw new Error('could not store "' + file.name + '" on this device (storage full?)');
      }
      saveState();
      return book;
    }

    async function addFiles(fileList) {
      var added = 0, refused = [];
      for (var i = 0; i < fileList.length; i++) {
        try { await addPdfFile(fileList[i]); added++; }
        catch (e) { refused.push(e.message); }
      }
      renderLibrary();
      if (added && refused.length) toast(added + ' added. ' + refused.join(' '));
      else if (added) toast(added === 1 ? 'Book added.' : added + ' books added.');
      else if (refused.length) toast(refused.join(' '));
    }

    $('pdf-file').addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    });
    var drop = $('drop-zone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });

    $('example-btn').addEventListener('click', async function () {
      /* The example document is generated on the device — no file
       * is shipped with the app. */
      try {
        var bytes = buildExamplePdf();
        if (!isPdfBytes(bytes)) throw new Error('the example could not be built');
        var blob = new Blob([bytes], { type: 'application/pdf' });
        var pdf = await pdfjsLib.getDocument({ data: bytes.slice(0).buffer }).promise;
        var pageCount = pdf.numPages;
        try { await pdf.destroy(); } catch (e) { /* already closed */ }
        var book = addBook(state, {
          title: EXAMPLE_TITLE, fileName: EXAMPLE_FILENAME,
          size: bytes.length, pageCount: pageCount
        });
        await window.LR_IDB.putPdf(book.id, blob);
        saveState();
        renderLibrary();
        toast('Example document added — tap Open to try the reader.');
      } catch (e) { toast(e.message); }
    });

    /* --- reader tab --- */
    var currentBook = null;      /* book metadata record */
    var currentPdf = null;       /* pdf.js PDFDocumentProxy */
    var currentPage = 1;
    var pageTexts = {};          /* page number -> extracted text */
    var indexedCount = 0;
    var indexing = false;
    var renderToken = 0;
    var zoomMode = 'fit';        /* 'fit' | '1' | '1.5' | '2' */

    function idb() { return window.LR_IDB || null; }

    async function openBook(id, page) {
      var book = findBook(state, id);
      if (!book) { toast('No such book.'); return; }
      if (!pdfjsLib) { toast('The PDF engine did not load — reload the app.'); return; }
      closeBook();
      var blob;
      try {
        blob = await idb().getPdf(id);
      } catch (e) { toast('Could not read the file from this device.'); return; }
      if (!blob) { toast('The file for "' + book.title + '" is gone — load it again.'); return; }
      var buf;
      try { buf = await blob.arrayBuffer(); } catch (e) { toast('Could not read the file.'); return; }
      var pdf;
      try {
        pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      } catch (e) { toast('"' + book.title + '" could not be opened.'); return; }
      currentBook = book;
      currentPdf = pdf;
      currentPage = Math.min(Math.max(page || 1, 1), book.pageCount);
      pageTexts = {};
      indexedCount = 0;
      indexing = false;
      $('reader-title').textContent = book.title;
      $('reader-meta').textContent = book.pageCount + ' pages · ' + fmtSize(book.size);
      $('search-input').value = '';
      $('search-results').innerHTML = '';
      showView('reader');
      await renderPage(currentPage);
      startIndexing();
    }

    function closeBook() {
      renderToken++;
      if (currentPdf) {
        var p = currentPdf;
        currentPdf = null;
        p.destroy().catch(function () { /* already closed */ });
      }
      currentBook = null;
      currentPage = 1;
      pageTexts = {};
      indexedCount = 0;
      indexing = false;
      var canvas = $('page-canvas');
      if (canvas) {
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      var tl = $('page-text-layer');
      if (tl) tl.innerHTML = '';
      $('reader-title').textContent = 'Reader';
      $('reader-meta').textContent = 'Pick a book from the Library tab.';
      $('index-status').textContent = '';
      $('page-indicator').textContent = '';
    }

    function pageViewport(page, scale) {
      return page.getViewport({ scale: scale });
    }

    async function renderPage(n) {
      if (!currentPdf || !currentBook) return;
      var token = ++renderToken;
      n = Math.min(Math.max(n, 1), currentBook.pageCount);
      currentPage = n;
      var page;
      try {
        page = await currentPdf.getPage(n);
      } catch (e) { toast('Could not load page ' + n + '.'); return; }
      if (token !== renderToken) return; /* a newer render took over */
      var container = $('page-wrap');
      var containerWidth = container.clientWidth || 800;
      var base = pageViewport(page, 1);
      var scale;
      if (zoomMode === 'fit') scale = containerWidth / base.width;
      else scale = parseFloat(zoomMode);
      var viewport = pageViewport(page, scale);
      var outputScale = Math.min(window.devicePixelRatio || 1, 2);
      var canvas = $('page-canvas');
      var ctx = canvas.getContext('2d');
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);
      var textLayer = $('page-text-layer');
      textLayer.innerHTML = '';
      textLayer.style.width = Math.floor(viewport.width) + 'px';
      textLayer.style.height = Math.floor(viewport.height) + 'px';
      /* pdf.js needs --scale-factor on the text-layer container, set
       * to the same value as viewport.scale, or it logs an error and
       * the selectable text can sit in the wrong place. */
      textLayer.style.setProperty('--scale-factor', scale);
      var renderTask = page.render({ canvasContext: ctx, viewport: viewport });
      var textContent;
      try { textContent = await page.getTextContent(); } catch (e) { textContent = null; }
      if (token !== renderToken) { try { renderTask.cancel(); } catch (e) { /* done */ } return; }
      try { await renderTask.promise; } catch (e) { /* cancelled by a newer render */ return; }
      if (textContent) {
        try {
          var tlTask = pdfjsLib.renderTextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport: viewport
          });
          await tlTask.promise;
        } catch (e) { /* text layer is a bonus — the canvas is the page */ }
      }
      $('page-indicator').textContent = 'Page ' + n + ' of ' + currentBook.pageCount;
      $('page-jump').value = n;
      try {
        setLastPage(state, currentBook.id, n);
        saveState();
      } catch (e) { /* state write failed; the page still shows */ }
      updateIndexStatus();
    }

    function goToPage(n) {
      if (!currentPdf) { toast('Open a book first.'); return; }
      renderPage(n);
    }

    $('page-prev').addEventListener('click', function () { goToPage(currentPage - 1); });
    $('page-next').addEventListener('click', function () { goToPage(currentPage + 1); });
    $('page-jump-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var n = parseInt($('page-jump').value, 10);
      if (!isNaN(n)) goToPage(n);
    });
    $('zoom-select').addEventListener('change', function (e) {
      zoomMode = e.target.value;
      if (currentPdf) renderPage(currentPage);
    });

    function updateIndexStatus() {
      if (!currentBook) { $('index-status').textContent = ''; return; }
      if (indexedCount >= currentBook.pageCount) {
        $('index-status').textContent = 'Indexed — all ' + currentBook.pageCount + ' pages searchable.';
      } else if (indexing) {
        $('index-status').textContent = 'Indexing… ' + indexedCount + ' of ' + currentBook.pageCount + ' pages searchable so far.';
      } else {
        $('index-status').textContent = indexedCount + ' of ' + currentBook.pageCount + ' pages indexed.';
      }
    }

    async function startIndexing() {
      if (!currentPdf || !currentBook || indexing) return;
      indexing = true;
      var bookId = currentBook.id;
      var total = currentBook.pageCount;
      /* Reuse text already stored for this book, so a re-open does
       * not re-read every page. */
      try {
        var stored = await idb().getPageTexts(bookId);
        Object.keys(stored || {}).forEach(function (k) {
          var p = +k;
          if (p >= 1 && p <= total && !(p in pageTexts)) {
            pageTexts[p] = stored[k];
            indexedCount++;
          }
        });
      } catch (e) { /* no stored text — extract it all */ }
      updateIndexStatus();
      var BATCH = 4;
      for (var start = 1; start <= total; start += BATCH) {
        if (!currentPdf || currentBook.id !== bookId) return; /* book closed or changed */
        for (var p = start; p < Math.min(start + BATCH, total + 1); p++) {
          if (p in pageTexts) continue;
          try {
            var page = await currentPdf.getPage(p);
            var tc = await page.getTextContent();
            var text = tc.items.map(function (it) { return it.str || ''; }).join(' ');
            pageTexts[p] = text;
            indexedCount++;
            try { await idb().putPageText(bookId, p, text); } catch (e) { /* text stays in memory only */ }
          } catch (e) { pageTexts[p] = ''; indexedCount++; }
        }
        updateIndexStatus();
        await new Promise(function (r) { setTimeout(r, 0); });
      }
      indexing = false;
      updateIndexStatus();
    }

    /* --- search --- */
    var searchTimer = null;
    $('search-input').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 250);
    });
    $('search-form').addEventListener('submit', function (e) {
      e.preventDefault();
      clearTimeout(searchTimer);
      runSearch();
    });
    function runSearch() {
      var box = $('search-results');
      if (!currentBook) { box.innerHTML = '<p class="muted">Open a book first.</p>'; return; }
      var q = $('search-input').value.trim();
      if (q.length < MIN_SEARCH_LEN) {
        box.innerHTML = '<p class="muted">Type at least two letters to search.</p>';
        return;
      }
      var results = searchPages(pageTexts, q);
      var head = results.length + ' match' + (results.length === 1 ? '' : 'es') +
        ' on ' + new Set(results.map(function (r) { return r.page; })).size + ' page' +
        (results.length === 1 ? '' : 's') +
        ' · ' + indexedCount + ' of ' + currentBook.pageCount + ' pages indexed so far.';
      var html = '<p class="muted">' + esc(head) + '</p>';
      if (!results.length) {
        html += '<p class="muted">Nothing found yet — the rest of the book may still be indexing.</p>';
      }
      results.forEach(function (r) {
        var s = r.snippet;
        html += '<div class="card search-hit"><button class="secondary" data-page="' + r.page + '">' +
          'Page ' + r.page + ' · ' + r.count + '×</button> <span>' +
          esc(s.before) + '<mark>' + esc(s.match) + '</mark>' + esc(s.after) +
          '</span></div>';
      });
      box.innerHTML = html;
      box.querySelectorAll('[data-page]').forEach(function (btn) {
        btn.addEventListener('click', function () { goToPage(+btn.getAttribute('data-page')); });
      });
    }

    /* --- bookmark + note from the reader --- */
    $('bookmark-btn').addEventListener('click', function () {
      if (!currentBook) { toast('Open a book first.'); return; }
      try {
        addBookmark(state, { bookId: currentBook.id, page: currentPage, label: '' });
        saveState();
        toast('Bookmarked page ' + currentPage + '.');
      } catch (e) { toast(e.message); }
    });
    $('note-form').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!currentBook) { toast('Open a book first.'); return; }
      try {
        addNote(state, { bookId: currentBook.id, page: currentPage, text: $('note-text').value });
        saveState();
        $('note-text').value = '';
        toast('Note added on page ' + currentPage + '.');
      } catch (err) { toast(err.message); }
    });

    /* --- notes tab --- */
    function bookTitle(id) {
      var b = findBook(state, id);
      return b ? b.title : '(book removed)';
    }
    function renderNotes() {
      fillNotesFilter();
      var filter = $('notes-filter').value;
      var wrap = $('notes-list');
      wrap.innerHTML = '';
      var bms = state.bookmarks.filter(function (b) {
        return filter === 'all' || b.bookId === filter;
      }).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      var nts = state.notes.filter(function (n) {
        return filter === 'all' || n.bookId === filter;
      }).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      if (!bms.length && !nts.length) {
        wrap.appendChild(el('p', 'muted', 'No bookmarks or notes yet — open a book and bookmark a page or add a note.'));
        return;
      }
      if (bms.length) {
        wrap.appendChild(el('h3', null, 'Bookmarks'));
        bms.forEach(function (bm) {
          var card = el('div', 'card');
          card.appendChild(el('p', null, bm.label));
          card.appendChild(el('p', 'muted', bookTitle(bm.bookId) + ' · page ' + bm.page));
          var row = el('div');
          var go = el('button', 'secondary', 'Go to page');
          go.addEventListener('click', function () { openBook(bm.bookId, bm.page); });
          row.appendChild(go);
          var del = el('button', 'danger', 'Delete');
          del.addEventListener('click', function () {
            try { removeBookmark(state, bm.id); saveState(); renderNotes(); } catch (e) { toast(e.message); }
          });
          row.appendChild(del);
          card.appendChild(row);
          wrap.appendChild(card);
        });
      }
      if (nts.length) {
        wrap.appendChild(el('h3', null, 'Notes'));
        nts.forEach(function (nt) {
          var card = el('div', 'card');
          card.appendChild(el('p', null, nt.text));
          card.appendChild(el('p', 'muted', bookTitle(nt.bookId) + ' · page ' + nt.page));
          var row = el('div');
          var go = el('button', 'secondary', 'Go to page');
          go.addEventListener('click', function () { openBook(nt.bookId, nt.page); });
          row.appendChild(go);
          var edit = el('button', 'secondary', 'Edit');
          edit.addEventListener('click', function () {
            var ta = el('textarea');
            ta.rows = 3;
            ta.value = nt.text;
            var save = el('button', 'primary', 'Save');
            var cancel = el('button', 'secondary', 'Cancel');
            card.innerHTML = '';
            card.appendChild(ta);
            var r2 = el('div');
            r2.appendChild(save);
            r2.appendChild(cancel);
            card.appendChild(r2);
            save.addEventListener('click', function () {
              try {
                updateNote(state, nt.id, ta.value);
                saveState();
                renderNotes();
                toast('Note saved.');
              } catch (e) { toast(e.message); }
            });
            cancel.addEventListener('click', renderNotes);
          });
          row.appendChild(edit);
          var del = el('button', 'danger', 'Delete');
          del.addEventListener('click', function () {
            try { removeNote(state, nt.id); saveState(); renderNotes(); } catch (e) { toast(e.message); }
          });
          row.appendChild(del);
          card.appendChild(row);
          wrap.appendChild(card);
        });
      }
    }
    $('notes-filter').addEventListener('change', renderNotes);
    function fillNotesFilter() {
      var sel = $('notes-filter');
      var cur = sel.value || 'all';
      sel.innerHTML = '';
      var all = el('option', null, 'All books');
      all.value = 'all';
      sel.appendChild(all);
      state.books.slice().sort(function (a, b) { return a.title.localeCompare(b.title); })
        .forEach(function (b) {
          var o = el('option', null, b.title);
          o.value = b.id;
          sel.appendChild(o);
        });
      sel.value = Array.from(sel.options).some(function (o) { return o.value === cur; }) ? cur : 'all';
    }

    /* --- data tab --- */
    function renderData() {
      var c = counts(state);
      $('data-counts').innerHTML =
        '<strong>' + c.books + ' book' + (c.books === 1 ? '' : 's') + '</strong> · ' +
        c.pages + ' pages · ' + c.bookmarks + ' bookmark' + (c.bookmarks === 1 ? '' : 's') +
        ' · ' + c.notes + ' note' + (c.notes === 1 ? '' : 's') + ' · ' +
        fmtSize(c.bytes) + ' of PDFs stored on this device.';
      fillNotesFilter();
    }
    function download(name, text, type) {
      var blob = new Blob([text], { type: type || 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    }
    $('export-btn').addEventListener('click', function () {
      download('library-reader-backup.json', JSON.stringify(exportState(state), null, 2));
      toast('Backup downloaded.');
    });
    $('copy-export-btn').addEventListener('click', function () {
      var text = JSON.stringify(exportState(state), null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('Backup copied.'); },
          function () { toast('Copy failed — use Download instead.'); });
      } else { toast('Clipboard not available — use Download instead.'); }
    });
    async function doImportText(text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { toast('That is not valid JSON.'); return; }
      var res;
      try { res = importState(state, data); } catch (e) { toast(e.message); return; }
      saveState();
      var msg = 'Imported ' + res.applied.bookmarks + ' bookmark' +
        (res.applied.bookmarks === 1 ? '' : 's') + ' and ' + res.applied.notes +
        ' note' + (res.applied.notes === 1 ? '' : 's') + '.';
      if (res.skipped.bookmarks || res.skipped.notes) {
        msg += ' Skipped ' + (res.skipped.bookmarks + res.skipped.notes) +
          ' with no matching book in this library.';
      }
      if (res.missingBooks.length) {
        msg += ' Not in this library yet: ' + res.missingBooks.join(', ') +
          ' — load those PDFs first, then import again.';
      }
      toast(msg);
      renderNotes();
      renderData();
    }
    $('import-btn').addEventListener('click', async function () {
      var file = $('import-file').files && $('import-file').files[0];
      if (file) {
        var text = await file.text();
        $('import-file').value = '';
        doImportText(text);
      } else if ($('import-text').value.trim()) {
        doImportText($('import-text').value);
      } else {
        toast('Pick a backup file or paste JSON first.');
      }
    });
    $('delete-all-btn').addEventListener('click', async function () {
      var btn = $('delete-all-btn');
      if (!btn.getAttribute('data-armed')) {
        btn.setAttribute('data-armed', '1');
        btn.textContent = 'Tap again to confirm — everything goes';
        setTimeout(function () {
          btn.removeAttribute('data-armed');
          btn.textContent = 'Delete everything';
        }, 4000);
        return;
      }
      btn.removeAttribute('data-armed');
      btn.textContent = 'Delete everything';
      var ids = state.books.map(function (b) { return b.id; });
      state = emptyState();
      saveState();
      if (idb()) {
        for (var i = 0; i < ids.length; i++) {
          try { await idb().deleteBookData(ids[i]); } catch (e) { /* already gone */ }
        }
      }
      closeBook();
      toast('Library cleared.');
      renderLibrary();
      renderNotes();
      renderData();
    });

    /* --- init --- */
    renderLibrary();
    renderData();
    showView('library');
  })();
}
