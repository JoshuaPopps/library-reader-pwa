# Library Reader

Bring your own manual. Load a PDF from your device, read it page by
page, search it, bookmark it — fully offline, nothing uploaded, no
account.

## What it is

A PWA for reading the manuals you already own. The app ships with
**no manuals and no book content at all** — you load your own PDF
files on-device (file picker, or drag and drop onto the Library
tab), and they stay on the device: the PDF bytes live in IndexedDB,
the titles, bookmarks, and notes in local storage.

- **Library tab** — every book you loaded, with page count, size,
  and the page you left off. Rename, delete, or open one. The only
  document the app can create by itself is the example document:
  three pages of instructions about the reader, generated on the
  device by `buildExamplePdf()`, clearly labeled as an example.
- **Reader tab** — the page on a canvas with a selectable text
  layer, prev/next, page jump, zoom (fit width / 100% / 150% /
  200%). Pages index in the background while you read, so search
  works over the pages indexed so far; a search result jumps to
  its page. Bookmark the page, or add a note on it.
- **Notes tab** — every bookmark and note, grouped by book, with
  “Go to page”. Notes edit in place.
- **Data tab** — export/import a JSON backup of titles, bookmarks,
  and notes. The backup is metadata only — the PDFs are not in
  it; load them again on a new device, then import, and the
  bookmarks find their books again by title and size. Delete
  everything clears the whole library on this device.

## Rendering — why pdf.js, and why vendored

The reader renders with **pdf.js 3.11.174** (Mozilla, Apache 2.0),
vendored in `vendor/` — the app loads no CDN at runtime. pdf.js is
the only approach that gives both page rendering **and** in-document
text search fully offline: the browser's built-in PDF viewer cannot
be searched from the page and behaves inconsistently inside an
installed PWA, and a hand-rolled PDF text extractor fails on real
manuals (FlateDecode streams, custom font encodings, ToUnicode
maps). The worker (`vendor/pdf.worker.min.js`) parses off the main
thread; the text layer makes the rendered page selectable. The
Apache 2.0 license is in `vendor/LICENSE`.

## Storage

- localStorage `library-reader-v1`: book metadata, bookmarks, notes.
- IndexedDB database `library-reader-v1`: store `pdfs` (the PDF
  blobs, keyed by book id) and store `pages` (extracted text per
  page, keyed by book + page) so a re-opened book does not re-index.
- A book with the same title and size as one already in the
  library is refused as a duplicate.

## 1990 Treatment

Gloss tank black #070709, chrome, purple #9d6bff, UnifrakturCook
headings, Archivo Narrow body — adapted from the live dyno
`styles.css`. Buttons have no hover transform (the house hover
shift breaks Playwright stability checks and sticks after a tap
on touch). Icons are Pillow-drawn from `make_icons.py` (open book,
chrome pages, purple bookmark ribbon); the 512 icon was read back
and reads clearly as a book.

## Tests

- `node test.js` — 78 checks on the pure logic: PDF magic bytes,
  the example-PDF generator (valid file — xref offsets verified
  against the objects, deterministic bytes), search ranking and
  snippets, book/bookmark/note validation and cascade on delete,
  export/import merge behavior.
- `python3 test_ui.py` — Playwright in headless Chromium: empty
  library states the app ships no manuals, the example document
  renders page 1 on canvas with a selectable text layer, all 3
  pages index, search finds page 3 and jumps, bookmark + note land
  on Notes, note edits in place, page prev/jump work, a second PDF
  uploaded through the file picker opens and searches, data tab
  counts 2 books / 6 pages / 1 bookmark / 1 note. No page errors,
  no failed requests (Google Fonts tolerated).

See `TESTING.md` for how to run them.
