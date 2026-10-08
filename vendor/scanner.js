/* ============================================================================
   CampusFlow document reader
   ----------------------------------------------------------------------------
   Turns whatever a school already has — an Excel workbook, a PDF timetable, a
   CSV export, a photo of a wall chart — into rows the scanner can review.

   Three ideas make this work, and they are all offline:

   1. Spreadsheets are read as real cells (SheetJS). No OCR, no guessing.
   2. PDFs with a text layer are read as positioned text (pdf.js), not pixels.
      Only scans/photos fall back to OCR.
   3. Rows and columns are recovered from *where* text sits, not from how it is
      broken into lines. A timetable photographed at an angle loses its line
      breaks long before it loses its layout, so geometry is the reliable
      signal — the same code then serves PDFs, OCR and spreadsheets.

   Nothing here touches the network. The libraries ship in ./vendor and the
   service worker caches them, so all of this works with no connection.
   ============================================================================ */
(function (global) {
  "use strict";

  /* ----------------------------------------------------------------- paths
     The reader sits in vendor/ next to the libraries it drives, so it resolves
     them against its OWN script URL. That keeps it working from any page depth
     (the app is served from the root, but an installed PWA may not be). */
  const SELF_SRC = (function () {
    try {
      if (global.document && global.document.currentScript && global.document.currentScript.src)
        return global.document.currentScript.src;
      if (global.document) {
        const hit = global.document.querySelector && global.document.querySelector('script[data-lazy-src$="scanner.js"]');
        if (hit && hit.src) return hit.src;
      }
    } catch (_) {}
    return "";
  })();
  const BASE = SELF_SRC ? SELF_SRC.replace(/\/[^/]*$/, "/") : "./vendor/";
  const asset = f => BASE + f;

  /* ------------------------------------------------------------------ text */
  const str = v => (v == null ? "" : String(v));
  /* Zero-width joiners and bidi marks are invisible but break Sinhala/Tamil
     comparisons, so they are stripped before any matching happens. */
  const stripInvisible = s => s.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "");
  const squash = v => stripInvisible(str(v)).normalize("NFKC").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const isBlank = v => squash(v).length === 0;
  const collapse = v => str(v).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  const median = nums => {
    const a = nums.filter(n => typeof n === "number" && isFinite(n)).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  /* --------------------------------------------------------------- days */
  const DAY_EN = [
    ["mon", "monday", "mo", "mon.", "mnd"],
    ["tue", "tues", "tuesday", "tu", "tue.", "tues."],
    ["wed", "weds", "wednesday", "we", "wed."],
    ["thu", "thur", "thurs", "thursday", "th", "thu."],
    ["fri", "friday", "fr", "fri."],
    ["sat", "saturday", "sa", "sat."],
    ["sun", "sunday", "su", "sun."]
  ];
  /* Sinhala and Tamil day names, including the short forms schools write on charts. */
  const DAY_OTHER = [
    ["සඳුදා", "සදුදා", "සඳු", "திங்கள்", "திங்கட்கிழமை", "திங்"],
    ["අඟහරුවාදා", "අඟහ", "අඟ", "செவ்வாய்", "செவ்"],
    ["බදාදා", "බදා", "புதன்", "புத"],
    ["බ්‍රහස්පතින්දා", "බ්‍රහස්", "බ්‍රහ", "வியாழன்", "வியா"],
    ["සිකුරාදා", "සිකු", "வெள்ளி", "வெள்"],
    ["සෙනසුරාදා", "සෙන", "சனி"],
    ["ඉරිදා", "ඉරි", "ஞாயிறு", "ஞாயி"]
  ];

  /* Returns 0=Mon .. 6=Sun, or -1. Header cells often carry extra words
     ("Mon 8:00", "Monday Period 1"), so a prefix/contains match is allowed —
     but only for the day words themselves, never for the whole cell. */
  function dayIndexFromText(text) {
    const t = stripInvisible(squash(text)).toLowerCase();
    if (!t || t.length > 40) return -1;
    for (let d = 0; d < DAY_OTHER.length; d++) {
      for (const w of DAY_OTHER[d]) {
        const wl = stripInvisible(w).toLowerCase();
        if (t === wl || t.indexOf(wl) === 0) return d;
      }
    }
    const tokens = t.split(/[^a-z]+/).filter(Boolean);
    for (const tok of tokens) {
      for (let d = 0; d < DAY_EN.length; d++) if (DAY_EN[d].indexOf(tok) !== -1) return d;
    }
    /* "Monday8:00" and "MON/TUE" styles: also accept a leading day prefix. */
    for (let d = 0; d < DAY_EN.length; d++) {
      for (const w of DAY_EN[d]) if (w.length > 3 && t.indexOf(w) === 0) return d;
    }
    return -1;
  }

  /* -------------------------------------------------------------- periods */
  const PERIOD_RE = /^(?:period|per|pe|pd|p|පීරියඩ්|කාලය)?\s*[.:\-]?\s*(\d{1,2})\s*(?:st|nd|rd|th|වන|வது)?\s*(?:period)?$/i;
  const TIME_RE = /(\d{1,2})\s*[.:]\s*(\d{2})\s*(?:a\.?m\.?|p\.?m\.?)?/gi;
  const RANGE_RE = /^\s*\d{1,2}\s*[.:]\s*\d{2}\s*(?:-|–|—|to|until|සිට|to)\s*\d{1,2}\s*[.:]\s*\d{2}\s*$/i;
  const ROOM_RE = /(?:^|[\s(])(?:room|rm|hall|lab|laboratory|auditorium|r)\s*[.:\-]?\s*([a-z0-9\u0D80-\u0DFF\u0B80-\u0BFF]{1,14})\b/i;

  /* Reads a period label. Returns {period:n|null, time:"08:20"|null} or null. */
  function periodInfoFromText(text) {
    const t = squash(text);
    if (!t || t.length > 28) return null;
    /* A time is never a period number: "8:20" must not read as period 8. The
       negative lookahead rejects a number that is followed by a clock, while
       still allowing "Period 4 10:40" and "P4 (10:40)". */
    const m = t.match(/^(?:period|per|pe|pd|p|පීරියඩ්|කාලය)?\s*[.:\-]?\s*(\d{1,2})(?!\s*[.:]\s*\d{2})\s*(?:st|nd|rd|th|වන|வது)?\s*(?:period)?\b/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (isFinite(n) && n >= 1 && n <= 40) return { period: n, time: firstTime(t) };
    }
    if (RANGE_RE.test(t) || /^\d{1,2}\s*[.:]\s*\d{2}$/.test(t)) {
      const time = firstTime(t);
      if (time) return { period: null, time };
    }
    const bare = t.match(/^(\d{1,2})$/);
    if (bare) {
      const n = parseInt(bare[1], 10);
      if (n >= 1 && n <= 40) return { period: n, time: null };
    }
    return null;
  }
  function firstTime(text) {
    TIME_RE.lastIndex = 0;
    const m = TIME_RE.exec(text);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    if (h > 23) return null;
    return String(h).padStart(2, "0") + ":" + m[2];
  }

  /* --------------------------------------------------- geometry: clustering */
  /* Splits a set of intervals into bands. Two intervals belong to the same band
     when the gap between them is smaller than minGap. */
  function bandClusters(intervals, minGap) {
    const iv = intervals.filter(x => x && x.b > x.a).sort((p, q) => p.a - q.a);
    if (!iv.length) return [];
    const out = [];
    let cur = { a: iv[0].a, b: iv[0].b };
    for (let i = 1; i < iv.length; i++) {
      const x = iv[i];
      if (x.a - cur.b >= minGap) { out.push(cur); cur = { a: x.a, b: x.b }; }
      else if (x.b > cur.b) cur.b = x.b;
    }
    out.push(cur);
    return out;
  }
  function bandIndexOf(bands, v) {
    for (let i = 0; i < bands.length; i++) if (v >= bands[i].a - 0.5 && v <= bands[i].b + 0.5) return i;
    let best = -1, bd = Infinity;
    for (let i = 0; i < bands.length; i++) {
      const d = Math.min(Math.abs(v - bands[i].a), Math.abs(v - bands[i].b));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  /* Joins adjacent bands whose gap is too small to be a real separator — this is
     what keeps a two-line cell ("Maths" over "Mr Perera") inside one table row
     instead of turning it into two rows. */
  function mergeBands(bands, maxGap) {
    if (!bands.length) return bands;
    const out = [Object.assign({}, bands[0])];
    for (let i = 1; i < bands.length; i++) {
      const prev = out[out.length - 1];
      if (bands[i].a - prev.b < maxGap) prev.b = Math.max(prev.b, bands[i].b);
      else out.push(Object.assign({}, bands[i]));
    }
    return out;
  }

  /* ==========================================================================
     cleanOcrWords — throws away what the reader saw but nobody wrote.
     A printed table's cell borders come back as "|", "—", "l", "I" and similar
     tokens. Left in, they join unrelated columns into one and the whole layout
     collapses, so they are dropped before any geometry happens.
     ========================================================================== */
  const JUNK_ONLY = /^[|\-_–—−=+~:;.,'"’‘“”`^()[\]{}<>/\\*#!?\s\u00a0]+$/;
  const SINGLE_NOISE = /^[lIiJ|]$/;
  function cleanOcrWords(words) {
    return (words || []).filter(w => {
      const t = squash(w && w.text);
      if (!t) return false;
      if (JUNK_ONLY.test(t)) return false;
      if (t.length === 1 && SINGLE_NOISE.test(t) && (w.conf == null || w.conf < 0.8)) return false;
      if (t.length <= 2 && JUNK_ONLY.test(t.replace(/[0-9]/g, ""))) return false;
      return true;
    });
  }

  /* ==========================================================================
     buildGridFromBoxes — the heart of the reader.
     boxes: [{text, x0, y0, x1, y1, conf?}]  (from pdf.js text items or OCR words)
     Returns {cells, rowBands, colBands, rowCount, colCount, layout}
     ========================================================================== */
  function buildGridFromBoxes(boxes, opts) {
    opts = opts || {};
    const items = (boxes || [])
      .map(b => ({
        text: squash(b.text), x0: +b.x0, y0: +b.y0, x1: +b.x1, y1: +b.y1,
        conf: b.conf == null ? 1 : b.conf
      }))
      .filter(b => b.text && isFinite(b.x0) && isFinite(b.y0) && isFinite(b.x1) && isFinite(b.y1) && b.x1 > b.x0);
    if (!items.length) return null;

    const heights = items.map(i => i.y1 - i.y0);
    const lineH = median(heights) || 10;
    const widths = items.map(i => i.x1 - i.x0);
    const charW = Math.max(1.2, (median(widths) || lineH * 3) / 6);

    /* Rows first: split on horizontal gutters, then fuse bands that are only a
       line apart, because those are wrapped lines inside one row. */
    const rowSplit = opts.rowGap || Math.max(lineH * 0.45, 3);
    let rowBands = bandClusters(items.map(i => ({ a: i.y0, b: i.y1 })), rowSplit);
    rowBands = mergeBands(rowBands, Math.max(lineH * 0.95, opts.rowMerge || 0));

    /* Columns: a run of empty horizontal space wide enough to be a gutter
       separates two columns. The catch is that a title or a note spans the whole
       width and would bridge every gutter, hiding the columns completely — so
       only the rows that actually hold several separate items vote on where the
       columns are. A timetable always has at least one such row (its header). */
    const perRow = rowBands.map(() => []);
    for (const it of items) {
      const r = bandIndexOf(rowBands, (it.y0 + it.y1) / 2);
      if (r >= 0) perRow[r].push(it);
    }
    const widest = perRow.reduce((m, list) => Math.max(m, list.length), 0);
    const minItems = Math.max(3, Math.ceil(widest * 0.5));
    let sample = perRow.filter(list => list.length >= minItems).flat();
    if (sample.length < 2) sample = items;                  /* a plain two-column list */
    const colGap = opts.colGap || Math.max(charW * 1.6, lineH * 0.85);
    let colBands = bandClusters(sample.map(i => ({ a: i.x0, b: i.x1 })), colGap);

    /* Columns can also be read straight off the day headings: each heading sits
       above its own column, which is far more reliable than hunting for gutters
       when cells are close together or the page is slightly turned. Used only
       when clustering has clearly missed columns, so nothing that already works
       changes. */
    const daySpots = new Map();
    for (const it of items) {
      const d = dayIndexFromText(it.text);
      if (d === -1) continue;
      if (!daySpots.has(d)) daySpots.set(d, []);
      daySpots.get(d).push((it.x0 + it.x1) / 2);
    }
    /* One x per day, however many times the day is written on the page. */
    const dayCenters = Array.from(daySpots.entries())
      .map(([d, list]) => ({ d, c: median(list) }))
      .sort((a, b) => a.c - b.c);
    const dayHints = {};
    if (dayCenters.length >= 3) {
      /* Evenly spaced headings mean a hidden column can be put back where it
         belongs: if the last heading is "Thursday" and text continues to the
         right, the next column is Friday — that is how a week is written. */
      let cols = dayCenters.map(x => ({ d: x.d, c: x.c }));
      if (cols.length >= 2) {
        const pitch = (cols[cols.length - 1].c - cols[0].c) / (cols.length - 1);
        const rightmost = Math.max.apply(null, items.map(i => (i.x0 + i.x1) / 2));
        let guard = 0;
        while (pitch > 1 && rightmost > cols[cols.length - 1].c + pitch * 0.5 && guard++ < 3) {
          const next = cols[cols.length - 1];
          const d = next.d == null ? null : next.d + 1;
          if (d == null || d > 6) break;
          cols.push({ d, c: next.c + pitch });
        }
      }
      /* Each column owns the space half-way to its neighbours — never an open
         band, which would swallow the column beside it. */
      const pitch = cols.length > 1 ? (cols[cols.length - 1].c - cols[0].c) / (cols.length - 1) : lineH * 3;
      const leftEdge = cols[0].c - pitch / 2;
      const bands = cols.map((x, i) => ({
        a: i === 0 ? leftEdge : (cols[i - 1].c + x.c) / 2,
        b: i === cols.length - 1 ? x.c + pitch / 2 : (x.c + cols[i + 1].c) / 2,
        center: x.c
      }));
      if (items.some(it => (it.x0 + it.x1) / 2 < leftEdge - lineH * 0.5))
        bands.unshift({ a: -Infinity, b: leftEdge });      /* the Period/time column */
      cols.forEach((x, i) => { if (x.d != null && x.d >= 0) dayHints[i + (bands.length - cols.length)] = x.d; });
      colBands = bands;
    }

    /* Place every word in its row and column, then concatenate cell text in
       reading order (top to bottom, left to right). */
    const cells = Array.from({ length: rowBands.length }, () => Array.from({ length: colBands.length }, () => []));
    for (const it of items) {
      const cx = (it.x0 + it.x1) / 2, cy = (it.y0 + it.y1) / 2;
      const r = bandIndexOf(rowBands, cy);
      const c = bandIndexOf(colBands, cx);
      if (r < 0 || c < 0) continue;
      cells[r][c].push(it);
    }
    const text = cells.map(row => row.map(list => {
      if (!list.length) return "";
      list.sort((a, b) => (Math.abs(a.y0 - b.y0) > lineH * 0.6) ? a.y0 - b.y0 : a.x0 - b.x0);
      let out = "";
      let lastY = null;
      for (const it of list) {
        if (lastY !== null && Math.abs(it.y0 - lastY) > lineH * 0.6) out += "\n";
        else if (out && !/\s$/.test(out)) out += " ";
        out += it.text;
        lastY = it.y0;
      }
      return collapse(out);
    }));

    return {
      cells: text,
      rowBands, colBands, dayHints,
      rowCount: rowBands.length, colCount: colBands.length,
      layout: "boxes"
    };
  }

  /* ==========================================================================
     buildGridFromMatrix — spreadsheets and CSVs are already a grid.
     Handles trailing empty rows/columns and ragged rows.
     ========================================================================== */
  function buildGridFromMatrix(matrix) {
    if (!Array.isArray(matrix) || !matrix.length) return null;
    const rows = matrix.map(r => (Array.isArray(r) ? r : [r]).map(v => focusCellText(v)));
    while (rows.length && rows[rows.length - 1].every(isBlank)) rows.pop();
    while (rows.length && rows[0].every(isBlank)) rows.shift();
    if (!rows.length) return null;
    let width = Math.max.apply(null, rows.map(r => r.length));
    if (!width) return null;
    /* Trim columns that are empty all the way down. `width` must be reassigned —
       testing a constant in this loop never terminates. */
    while (width > 1 && rows.every(r => isBlank(r[width - 1]))) width--;
    rows.forEach(r => { r.length = width; });
    return { cells: rows, rowCount: rows.length, colCount: Math.max.apply(null, rows.map(r => r.length)), layout: "matrix" };
  }

  /* A spreadsheet cell can hold a date, a number or a long note. Dates and
     numbers arrive as Date objects from SheetJS when cellDates is on. */
  function focusCellText(v) {
    if (v == null) return "";
    if (v instanceof Date) return collapse(v.toISOString().slice(0, 10));
    if (typeof v === "object") {
      if (v.text != null) return collapse(v.text);
      if (v.richText) return collapse(v.richText.map(t => str(t.text)).join(""));
      if (v.result != null) return collapse(v.result);
      if (v.w != null) return collapse(v.w);
      return "";
    }
    return collapse(v);
  }

  /* ==========================================================================
     interpretGrid — works out what the grid MEANS: which row holds the days,
     which column holds the periods, and which way round it is.
     ========================================================================== */
  function interpretGrid(grid, opts) {
    opts = opts || {};
    const days = opts.daysPerWeek || 6;
    const cells = grid.cells;
    const R = cells.length, C = cells[0] ? cells[0].length : 0;

    /* How many day names sit in each row and each column? */
    const dayRowHits = [], dayColHits = [];
    for (let r = 0; r < R; r++) {
      let n = 0;
      for (let c = 0; c < C; c++) if (dayIndexFromText(cells[r][c]) !== -1) n++;
      dayRowHits.push(n);
    }
    for (let c = 0; c < C; c++) {
      let n = 0;
      for (let r = 0; r < R; r++) if (dayIndexFromText(cells[r][c]) !== -1) n++;
      dayColHits.push(n);
    }
    const bestDayRow = dayRowHits.reduce((b, n, i) => (n > dayRowHits[b] ? i : b), 0);
    const bestDayCol = dayColHits.reduce((b, n, i) => (n > dayColHits[b] ? i : b), 0);

    const out = {
      headerRow: null, dayByCol: {}, dayByRow: {}, dayColumn: null,
      periodByRow: {}, periodCol: null, orientation: null, recognised: false,
      gridCells: cells
    };

    /* Days across the top (the usual layout), unless days clearly run down a column. */
    if (dayRowHits[bestDayRow] >= 2 && dayRowHits[bestDayRow] >= dayColHits[bestDayCol]) {
      out.headerRow = bestDayRow;
      out.orientation = "days-cols";
      for (let c = 0; c < C; c++) {
        const d = dayIndexFromText(cells[bestDayRow][c]);
        if (d !== -1 && out.dayByCol[d] == null) out.dayByCol[d] = c;
      }
      out.recognised = true;
      /* A column whose heading was never read still has a day, worked out from
         the headings that WERE read (see buildGridFromBoxes). */
      if (grid.dayHints) {
        Object.keys(grid.dayHints).forEach(k => {
          const c = +k, d = grid.dayHints[k];
          if (c > 0 && c < C && d >= 0 && out.dayByCol[d] == null) out.dayByCol[d] = c;
        });
      }
    } else if (dayColHits[bestDayCol] >= 2) {
      out.dayColumn = bestDayCol;
      out.orientation = "days-rows";
      for (let r = 0; r < R; r++) {
        const d = dayIndexFromText(cells[r][bestDayCol]);
        if (d !== -1 && out.dayByRow[d] == null) out.dayByRow[d] = r;
      }
      out.recognised = true;
    }

    /* Period labels: look for them in the leading columns (days-across layout)
       or in the header row (days-down layout). */
    if (out.orientation === "days-cols") {
      const start = out.headerRow == null ? 0 : out.headerRow + 1;
      const labelCols = Math.min(3, Math.max(1, C - Object.keys(out.dayByCol).length));
      let best = { col: -1, hits: 0 };
      for (let c = 0; c < labelCols; c++) {
        let hits = 0;
        for (let r = start; r < R; r++) if (periodInfoFromText(cells[r][c])) hits++;
        if (hits > best.hits) best = { col: c, hits };
      }
      if (best.hits >= 1) {
        out.periodCol = best.col;
        for (let r = start; r < R; r++) {
          const p = periodInfoFromText(cells[r][best.col]);
          if (p) out.periodByRow[r] = p;
        }
        /* A period number is easy to lose — "4" comes back as "a", or the cell is
           empty. A row below the last period that holds lessons in two or more
           day columns is still a period, so it keeps its place in the week
           instead of silently dropping its lessons. */
        const dayCols = Object.keys(out.dayByCol).map(Number).map(d => out.dayByCol[d]);
        const rows = Object.keys(out.periodByRow).map(Number).sort((a, b) => a - b);
        const lastNamed = rows.length ? rows[rows.length - 1] : out.headerRow;
        for (let r = (lastNamed == null ? -1 : lastNamed) + 1; r < R; r++) {
          const filled = dayCols.filter(c => !isBlank(cells[r][c])).length;
          if (filled >= 2) out.periodByRow[r] = { period: null, time: null, inferred: true };
        }
      }
      /* No label column at all: rows below the header are periods 1..n. */
      if (out.periodCol === null) {
        for (let r = start; r < R; r++) if (!cells[r].every(isBlank)) out.periodByRow[r] = { period: null, time: null };
      }
    } else if (out.orientation === "days-rows") {
      const headerRow = opts.headerRowHint == null ? 0 : opts.headerRowHint;
      for (let c = 0; c < C; c++) {
        const p = periodInfoFromText(cells[headerRow][c]);
        if (p) out.periodByRow[c] = p;
      }
    }

    /* Nothing matched a day name? Fall back to the shape of the data: a table
       with one label column and daysPerWeek data columns is almost always a
       timetable, and saying so is better than refusing to read it. */
    if (!out.recognised) {
      if (C === days + 1 || C === days) {
        const offset = C === days + 1 ? 1 : 0;
        out.orientation = "days-cols";
        out.headerRow = null;
        out.periodCol = offset ? 0 : null;
        for (let d = 0; d < days; d++) out.dayByCol[d] = d + offset;
        for (let r = 0; r < R; r++) if (!cells[r].every(isBlank)) out.periodByRow[r] = periodInfoFromText(cells[r][out.periodCol]) || { period: null, time: null };
        out.recognised = true;
        out.assumed = true;
      } else if (R === days + 1 || R === days) {
        const offset = R === days + 1 ? 1 : 0;
        out.orientation = "days-rows";
        out.dayColumn = offset ? 0 : null;
        out.headerRow = 0;
        for (let d = 0; d < days; d++) out.dayByRow[d] = d + offset;
        for (let c = 0; c < C; c++) { const p = periodInfoFromText(cells[0][c]); if (p) out.periodByRow[c] = p; }
        out.recognised = true;
        out.assumed = true;
      }
    }
    return out;
  }

  /* ==========================================================================
     Cell contents — "Maths - Mr Perera (Room 12)" becomes a subject, a teacher
     and a room. Both orders are scored and the better one wins, so a school
     that writes "Perera / Maths" is read just as happily.
     ========================================================================== */
  function splitCellParts(text) {
    const t = collapse(text);
    if (!t) return [];
    const parts = [];
    t.split(/\n+/).forEach(line => {
      /* Parenthesised notes become their own part so "(Room 12)" is pickable. */
      line.replace(/\(([^)]*)\)/g, " ($1) ").split(/[|•·;,\/+]|\s[-–—]\s|\s{3,}/g)
        .forEach(p => { const s = squash(p).replace(/^[-–—\s]+|[-–—\s]+$/g, ""); if (s) parts.push(s); });
    });
    return parts;
  }

  /* Rooms are pulled out of the text before anything else is matched, so both
     "Science (Room 12)" and "ICT Lab 2" keep their subject and gain a room. */
  const ROOM_TOKEN_RE = /\(?\b(?:room|rm|hall|lab|laboratory|auditorium)\s*[.:\-]?\s*[a-z0-9]{1,14}\b\)?/gi;
  function extractRoom(raw) {
    ROOM_TOKEN_RE.lastIndex = 0;
    const hit = raw.match(ROOM_TOKEN_RE);
    if (!hit) return { room: null, text: raw };
    /* "(Lab 2)" and "Lab 2" mean the same thing — keep the brackets out of the data. */
    const room = squash(hit[0]).replace(/^\(\s*|\s*\)$/g, "").trim();
    return { room: room, text: squash(raw.replace(ROOM_TOKEN_RE, " ")) };
  }

  /* ctx.matchSubject / ctx.matchTeacher return {item, score}. */
  function parseCellText(text, ctx) {
    ctx = ctx || {};
    const original = collapse(text);
    const result = { raw: original, subject: null, teacher: null, room: null, subjects: [], teachers: [], score: 0 };
    if (!original || /^[-–—.\s]+$/.test(original)) return result;

    const roomless = extractRoom(original);
    result.room = roomless.room;
    const raw = roomless.text || original;

    const parts = splitCellParts(raw);
    const consider = parts.length ? parts : [raw];
    let bestSubject = 0, bestTeacher = 0;

    for (const p of consider) {
      const s = ctx.matchSubject ? ctx.matchSubject(p) : null;
      const t = ctx.matchTeacher ? ctx.matchTeacher(p) : null;
      const sScore = s && s.item ? s.score : 0;
      const tScore = t && t.item ? t.score : 0;
      if (sScore >= tScore && s.item && sScore > bestSubject) {
        bestSubject = sScore;
        result.subject = s.item;
        result.subjects = [{ item: s.item, score: sScore }];
        if (t.item && tScore > 0.45) { result.teacher = t.item; bestTeacher = Math.max(bestTeacher, tScore); }
      } else if (t.item && tScore > bestTeacher) {
        bestTeacher = tScore;
        result.teacher = t.item;
      }
    }

    /* Nothing matched a fragment? Try the whole cell, then progressively shorter
       prefixes, which rescues "Maths 9B Perera" style writing. */
    if (!result.subject && ctx.matchSubject) {
      const whole = ctx.matchSubject(raw);
      if (whole && whole.item) { result.subject = whole.item; bestSubject = whole.score; }
      else {
        const words = raw.split(/\s+/).filter(Boolean);
        for (let n = Math.min(4, words.length); n >= 2 && !result.subject; n--) {
          const cand = words.slice(0, n).join(" ");
          const m = ctx.matchSubject(cand);
          if (m && m.item && m.score > 0.62) { result.subject = m.item; bestSubject = m.score; }
        }
      }
    }
    if (!result.teacher && ctx.matchTeacher && !result.subject) {
      const whole = ctx.matchTeacher(raw);
      if (whole && whole.item) { result.teacher = whole.item; bestTeacher = whole.score; }
    }

    result.subjects = result.subject ? [{ item: result.subject, score: bestSubject }] : [];
    result.teachers = result.teacher ? [{ item: result.teacher, score: bestTeacher }] : [];
    result.score = Math.max(bestSubject, bestTeacher);
    return result;
  }

  /* ==========================================================================
     gridToTimetable — the final step: place subjects into [period][day].
     ids come from the caller's matchers, so this file stays free of app state.
     ========================================================================== */
  function gridToTimetable(model, ctx) {
    ctx = ctx || {};
    const periods = Math.max(1, ctx.periodsPerDay || 8);
    const days = Math.max(1, ctx.daysPerWeek || 6);
    const grid = Array.from({ length: periods }, () => Array.from({ length: days }, () => null));
    const report = { placed: 0, matched: 0, raw: 0, unmatched: [], cells: [] };

    const cellAt = (r, c) => (model.gridCells && model.gridCells[r] ? str(model.gridCells[r][c]) : "");

    if (model.orientation === "days-cols") {
      const rowList = Object.keys(model.periodByRow).map(Number).sort((a, b) => a - b);
      rowList.forEach((r, i) => {
        const slot = i;                                   /* row order is the period order */
        if (slot >= periods) return;
        Object.keys(model.dayByCol).forEach(dk => {
          const d = +dk;
          if (d >= days) return;
          const c = model.dayByCol[dk];
          if (model.periodCol !== null && c === model.periodCol) return;
          const text = cellAt(r, c);
          if (isBlank(text)) return;
          const parsed = parseCellText(text, ctx);
          const subjectId = parsed.subject ? parsed.subject.id : null;
          const teacherId = parsed.teacher ? parsed.teacher.id : null;
          report.cells.push({ r, c, d, slot, text, parsed });
          if (!subjectId && !teacherId) { report.unmatched.push(text); return; }
          grid[slot][d] = { raw: text, subjectId, teacherId, room: parsed.room, score: parsed.score };
          report.placed++;
          if (subjectId) report.matched++;
        });
      });
    } else if (model.orientation === "days-rows") {
      Object.keys(model.dayByRow).forEach(dk => {
        const d = +dk;
        if (d >= days) return;
        const r = model.dayByRow[dk];
        const colList = Object.keys(model.periodByRow).map(Number).sort((a, b) => a - b);
        colList.forEach((c, i) => {
          const slot = i;
          if (slot >= periods) return;
          if (model.dayColumn !== null && c === model.dayColumn) return;
          const text = cellAt(r, c);
          if (isBlank(text)) return;
          const parsed = parseCellText(text, ctx);
          const subjectId = parsed.subject ? parsed.subject.id : null;
          const teacherId = parsed.teacher ? parsed.teacher.id : null;
          report.cells.push({ r, c, d, slot, text, parsed });
          if (!subjectId && !teacherId) { report.unmatched.push(text); return; }
          grid[slot][d] = { raw: text, subjectId, teacherId, room: parsed.room, score: parsed.score };
          report.placed++;
          if (subjectId) report.matched++;
        });
      });
    }
    return { grid, report };
  }

  /* ==========================================================================
     File handling. Everything below is I/O; the logic above is pure and is
     covered by scanner.test.js in Node.
     ========================================================================== */
  const SHEET_EXT = /\.(xlsx|xlsm|xlsb|xls|csv|tsv|txt)$/i;
  const PDF_EXT = /\.pdf$/i;
  const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif)$/i;

  function classifyFile(file) {
    const name = str(file && file.name);
    const type = str(file && file.type).toLowerCase();
    if (PDF_EXT.test(name) || type === "application/pdf") return "pdf";
    if (SHEET_EXT.test(name) || /spreadsheet|excel|csv|tab-separated/.test(type)) return "sheet";
    if (IMAGE_EXT.test(name) || type.indexOf("image/") === 0) return "image";
    return "unknown";
  }

  /* ------------------------------------------------------------- loaders */
  function loadScript(src, test) {
    if (test && test()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = () => (test && !test() ? reject(new Error("loader did not define what it should")) : resolve());
      s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }
  let xlsxPromise = null, pdfPromise = null;
  function ensureXlsx() {
    if (global.XLSX) return Promise.resolve(global.XLSX);
    if (!xlsxPromise) xlsxPromise = loadScript(asset("xlsx.full.min.js"), () => !!global.XLSX)
      .then(() => global.XLSX)
      .catch(e => { xlsxPromise = null; throw new Error("The spreadsheet reader could not start. " + e.message); });
    return xlsxPromise;
  }
  async function ensurePdf() {
    if (global.__cfPdf) return global.__cfPdf;
    if (!pdfPromise) {
      pdfPromise = import(/* the real vendor path, resolved from this script */ asset("pdf.min.mjs"))
        .then(lib => {
          lib.GlobalWorkerOptions.workerSrc = asset("pdf.worker.min.mjs");
          global.__cfPdf = lib;
          return lib;
        })
        .catch(e => { pdfPromise = null; throw new Error("The PDF reader could not start. " + e.message); });
    }
    return pdfPromise;
  }

  /* -------------------------------------------------------- spreadsheet */
  /* Reads every sheet so the caller (or the user) can choose. Formula results
     are preferred over formulas, dates are kept as dates. */
  async function readSheetFile(file) {
    const XLSX = await ensureXlsx();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true, cellText: true, raw: false });
    const sheets = [];
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      if (!ws) continue;
      const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: true });
      const grid = buildGridFromMatrix(matrix);
      if (!grid) continue;
      const filled = grid.cells.reduce((n, row) => n + row.filter(c => !isBlank(c)).length, 0);
      sheets.push({ name, grid, matrix, filled });
    }
    /* The timetable is nearly always the busiest sheet, so rank by content. */
    sheets.sort((a, b) => b.filled - a.filled);
    return { kind: "sheet", sheets, best: sheets[0] || null };
  }

  /* ---------------------------------------------------------------- pdf */
  /* Text items carry their position, so a PDF with a text layer is read exactly
     — no OCR. Scanned PDFs produce (almost) no text items and are reported as
     needing OCR instead. */
  async function readPdfFile(file, onPage) {
    const pdfjs = await ensurePdf();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const boxes = [];
      for (const item of content.items) {
        const t = squash(item.str);
        if (!t) continue;
        const tr = item.transform;
        const x = tr[4], y = tr[5];
        const h = Math.abs(tr[3]) || Math.abs(item.height) || 10;
        const w = Math.abs(item.width) || t.length * h * 0.5;
        /* PDF y grows upwards; flip it so rows sort top-down like OCR output. */
        boxes.push({ text: t, x0: x, x1: x + w, y0: viewport.height - y - h, y1: viewport.height - y, conf: 1 });
      }
      const grid = boxes.length >= 4 ? buildGridFromBoxes(boxes) : null;
      const chars = boxes.reduce((n, b) => n + b.text.length, 0);
      pages.push({ page: p, boxes, grid, chars, needsOcr: chars < 24 });
      if (onPage) onPage(p, doc.numPages, chars);
    }
    const usable = pages.filter(p => p.grid && !p.needsOcr);
    return {
      kind: "pdf", numPages: doc.numPages, pages,
      best: usable.sort((a, b) => b.chars - a.chars)[0] || null,
      needsOcr: !usable.length,
      document: doc
    };
  }

  /* ---------------------------------------------------------------- csv */
  /* A CSV that holds one long column of "Mon P1 Maths" text is not a grid at
     all; this detects that shape and hands back plain lines instead. */
  function linesFromGrid(grid) {
    const out = [];
    for (const row of grid.cells) {
      const filled = row.filter(c => !isBlank(c));
      if (!filled.length) continue;
      if (filled.length === 1) out.push(filled[0]);
      else {
        const label = periodInfoFromText(row[0]) || dayIndexFromText(row[0]) !== -1;
        out.push(joinRow(label ? row.slice(1) : row));
      }
    }
    return out;
  }
  function joinRow(row) { return row.map(c => squash(c)).filter(Boolean).join(" | "); }

  /* ==========================================================================
     Public surface. Pure functions are exported for tests as well as for the
     app, and the async readers are what index.html actually calls.
     ========================================================================== */
  global.Scanner = {
    /* pure */
    squash, collapse, isBlank, median,
    dayIndexFromText, periodInfoFromText, firstTime,
    bandClusters, mergeBands, bandIndexOf,
    buildGridFromBoxes, buildGridFromMatrix, interpretGrid,
    splitCellParts, parseCellText, gridToTimetable, linesFromGrid, joinRow,
    /* io */
    base: BASE, asset, cleanOcrWords,
    classifyFile, ensureXlsx, ensurePdf, readSheetFile, readPdfFile,
    SHEET_EXT, PDF_EXT, IMAGE_EXT
  };
})(typeof window !== "undefined" ? window : globalThis);
