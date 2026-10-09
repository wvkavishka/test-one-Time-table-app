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
  /* Characters that are invisible, or that a PDF hands back when its font has no
     proper Unicode mapping: NUL, other C0 controls, the replacement character,
     soft hyphen, and the bidi/zero-width marks. Zero-width joiner and
     non-joiner are deliberately KEPT — Sinhala and Tamil need them to render
     ("ප්‍රනාන්දු"), so they are removed only when comparing, never when showing.
     Applied on the way in (squash) and on the way out (matchKey), so a text
     layer full of NULs still reads and still displays as something sensible. */
  const BROKEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd\u00ad]/g;
  const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2060\ufeff]/g;
  const stripInvisible = s => str(s).replace(BROKEN, "").replace(INVISIBLE, "");
  const squash = v => stripInvisible(str(v)).normalize("NFKC").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  /* A comparison key that survives what OCR and old PDF fonts do to text:
     joiner marks dropped, NFKC-normalised, whitespace collapsed. */
  const matchKey = v => squash(v).replace(/[\u200c\u200d]/g, "");
  /* The same key with every separator removed — PDF text layers love to split a
     word into pieces ("සඳු" + "දා"), so the tight key is how those come back
     together for matching. */
  const tightKey = v => matchKey(v).replace(/[\s.·:;,\-–—_/|'"]+/g, "");
  /* Scanner watermarks are printed ON the page, so they arrive as real words
     ("Scanned by CamScanner"). They must never become lessons. */
  const WATERMARK = /(?:scanned\s*by\s*)?cam\s*scanner|adobe\s*scan|microsoft\s*lens|genius\s*scan|scanbot|doc\s*scan|scan\s*pro\b/i;
  const BRANDS = ["camscanner", "adobescan", "microsoftlens", "geniusscan", "scanbot", "docscan"];
  /* OCR does not spell "CamScanner" reliably — it comes back as "Carmcanner",
     "CamScarmer", "CarnScanner". So the test is on letters only, and a near
     miss of a known scanner brand still counts as a watermark. */
  function isWatermarkText(text) {
    const t = squash(text);
    if (!t) return false;
    if (WATERMARK.test(t)) return true;
    if (/scanned\s*by/i.test(t)) return true;
    const letters = t.toLowerCase().replace(/[^a-z]/g, "");
    if (letters.length < 6) return false;
    for (const b of BRANDS) {
      if (letters === b) return true;
      if (Math.abs(letters.length - b.length) <= 3 && editDistance(letters, b) <= 2) return true;
    }
    return false;
  }
  const stripWatermarks = v => {
    const t = squash(str(v).replace(WATERMARK, " "));
    return isWatermarkText(t) ? "" : t;
  };
  const isBlank = v => squash(v).length === 0;
  const collapse = v => str(v).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  const median = nums => {
    const a = nums.filter(n => typeof n === "number" && isFinite(n)).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  /* Which writing system is this text in? Used to choose an OCR language pack
     (and to tell the user why a page needed one) without asking them first. */
  const SCRIPT_RANGES = [
    ["sinhala", /[\u0d80-\u0dff]/g],
    ["tamil", /[\u0b80-\u0bff]/g],
    ["devanagari", /[\u0900-\u097f]/g],
    ["arabic", /[\u0600-\u06ff]/g]
  ];
  function scriptOf(text) {
    const t = str(text);
    let best = "", hits = 0;
    for (const [name, re] of SCRIPT_RANGES) {
      const n = (t.match(re) || []).length;
      if (n > hits) { hits = n; best = name; }
    }
    const latin = (t.match(/[A-Za-z]/g) || []).length;
    if (!best) return latin > 2 ? "latin" : "";
    return latin > hits * 2 ? "latin" : best;
  }

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
    const t = matchKey(text).toLowerCase();
    if (!t || t.length > 40) return -1;
    const tight = tightKey(text).toLowerCase();
    for (let d = 0; d < DAY_OTHER.length; d++) {
      for (const w of DAY_OTHER[d]) {
        const wl = matchKey(w).toLowerCase();
        const wt = tightKey(w).toLowerCase();
        /* Loose: the day name leads the cell ("මඟුල් සඳුදා", "Mon 8:00"). Tight:
           the same name with the spaces a broken text layer inserted removed. */
        if (t === wl || t.indexOf(wl) === 0) return d;
        if (wt && tight && (tight === wt || tight.indexOf(wt) === 0)) return d;
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
    /* Last resort: a heading the FILE mangled. Old PDF writers drop the letters
       they cannot map — "බ්‍රහස්පතින්දා" comes back as "බහස්පතින්දා" — so a close
       spelling still means that day. Only accepted when the best match is clearly
       better than the runner-up, so "Mon" can never drift into "Thu". */
    if (tight.length >= 4) {
      const scored = [];
      for (let d = 0; d < DAY_OTHER.length; d++) {
        let best = 0;
        for (const w of DAY_OTHER[d]) {
          const wt = tightKey(w).toLowerCase();
          if (!wt) continue;
          const s = 1 - editDistance(tight, wt) / Math.max(tight.length, wt.length);
          if (s > best) best = s;
        }
        scored.push({ d, s: best });
      }
      scored.sort((a, b) => b.s - a.s);
      if (scored[0].s >= 0.75 && scored[0].s - (scored[1] ? scored[1].s : 0) >= 0.12) return scored[0].d;
    }
    return -1;
  }
  /* Plain Levenshtein, used only for that last-resort day match. */
  function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
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
    const kept = (words || []).filter(w => {
      const t = squash(w && w.text);
      if (!t) return false;
      if (isWatermarkText(t)) return false;
      if (JUNK_ONLY.test(t)) return false;
      if (t.length === 1 && SINGLE_NOISE.test(t) && (w.conf == null || w.conf < 0.8)) return false;
      if (t.length <= 2 && JUNK_ONLY.test(t.replace(/[0-9]/g, ""))) return false;
      return true;
    });
    /* OCR splits the stamp across boxes as often as it mangles it, so once a
       watermark is known to be on the page its leftovers ("scanned", "by",
       "cam", "scanner") are dropped too — no timetable cell holds those words.
       The stamp is looked for in the ORIGINAL list: the word that gave it away
       has already been removed by the filter above. */
    const stamped = (words || []).some(w => isWatermarkText(w && w.text));
    return stamped
      ? kept.filter(w => !/^(scanned|scan|cam|carm|scanner|camscanner|carmcanner|by)$/i.test(squash(w.text)))
      : kept;
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
    /* Do the boxes overlap one another on a line? PDFs whose fonts lost their
       width table report a width that does not cover the text, so a box appears
       to start inside the one before it. When that is common, the only reliable
       signal left is where each word BEGINS — a broken width cannot move a start
       position. A page that reports sane widths is left exactly as it was. */
    const overlapOf = list => {
      let pairs = 0, bad = 0;
      const byRow = new Map();
      list.forEach(it => {
        const k = Math.round((it.y0 + it.y1) / 2 / Math.max(2, lineH));
        if (!byRow.has(k)) byRow.set(k, []);
        byRow.get(k).push(it);
      });
      byRow.forEach(row => {
        row.sort((a, b) => a.x0 - b.x0);
        for (let i = 1; i < row.length; i++) {
          const gap = row[i].x0 - row[i - 1].x1;
          pairs++;
          if (gap < -lineH * 0.12) bad++;
        }
      });
      return pairs ? bad / pairs : 0;
    };
    const overlap = overlapOf(items);
    const brokenWidths = overlap > 0.18;
    /* Where a word sits, for column purposes. */
    const anchorX = it => (brokenWidths ? it.x0 : (it.x0 + it.x1) / 2);

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
      daySpots.get(d).push(anchorX(it));
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
        const rightmost = Math.max.apply(null, items.map(i => anchorX(i)));
        const leftmost = Math.min.apply(null, items.map(i => anchorX(i)));
        let guard = 0;
        while (pitch > 1 && rightmost > cols[cols.length - 1].c + pitch * 0.5 && guard++ < 3) {
          const next = cols[cols.length - 1];
          const d = next.d == null ? null : next.d + 1;
          if (d == null || d > 6) break;
          cols.push({ d, c: next.c + pitch });
        }
        /* The same reasoning on the left. A shaded or creased edge often loses
           the first heading — "Monday" is the one nearest the spine — and the
           whole week then shifts a day early or loses Monday's lessons. If the
           first day read is not Monday and there is room for another column at
           the same spacing, that column is Monday; what remains further left is
           the period column, which is found separately below. */
        guard = 0;
        /* ...but only on evidence. The space left of the first day read normally
           holds the PERIOD column, so adding a day there without proof would
           push the period numbers into Monday and shift the whole week. Proof is
           text that cannot be a period label — a subject or a teacher's name. */
        const leftOf = cols[0].c - pitch * 0.5;
        const leftItems = items.filter(it => anchorX(it) < leftOf);
        const leftLooksLikeLessons = leftItems.some(it => {
          const t = it.text;
          if (periodInfoFromText(t)) return false;
          return /[\p{L}]{3,}/u.test(t);
        });
        while (leftLooksLikeLessons && pitch > 1 && cols[0].d > 0 &&
               cols[0].c - pitch > leftmost + pitch * 0.35 && guard++ < 3) {
          cols.unshift({ d: cols[0].d - 1, c: cols[0].c - pitch });
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
      /* Is there anything to the LEFT of the first day heading? Period numbers,
         times and "Period" labels live there. The test used to need half a line
         of clearance, so a period column tucked close to Monday was swallowed by
         Monday's band — and the lesson ended up in the same cell as its period
         number. Any text left of the edge is enough. */
      if (items.some(it => anchorX(it) < leftEdge - lineH * 0.15))
        bands.unshift({ a: -Infinity, b: leftEdge });      /* the Period/time column */
      cols.forEach((x, i) => { if (x.d != null && x.d >= 0) dayHints[i + (bands.length - cols.length)] = x.d; });
      colBands = bands;
    }

    /* Place every word in its row and column, then concatenate cell text in
       reading order (top to bottom, left to right). */
    const cells = Array.from({ length: rowBands.length }, () => Array.from({ length: colBands.length }, () => []));
    for (const it of items) {
      const cx = anchorX(it), cy = (it.y0 + it.y1) / 2;
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
      layout: "boxes",
      /* Surfaced so the app can say WHY a page needed care, and so tests can
         assert the broken-width path runs. */
      brokenWidths, overlap: +overlap.toFixed(3)
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
        /* A single stray number can throw every row off: one page gave "4" for
           the first row, and the whole week shifted down by three periods. When
           most of the period column could not be read, the numbers that were
           read are not trustworthy — the rows are numbered in order instead, and
           the page says so. */
        const named = Object.keys(out.periodByRow).filter(k => +k >= start).length;
        const candidate = [];
        for (let r = start; r < R; r++) {
          const filled = Object.keys(out.dayByCol).filter(c => !isBlank(cells[r][+out.dayByCol[c]])).length;
          if (filled >= 2) candidate.push(r);
        }
        if (candidate.length >= 2 && named > 0 && named < Math.ceil(candidate.length / 2)) {
          out.periodByRow = {};
          candidate.forEach((r, i) => { out.periodByRow[r] = { period: i + 1, time: null }; });
          out.assumed = "periods-in-order";
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

    /* Reading a week is a decision too. The period labels may have been read
       perfectly, or a single stray number may have survived while the rest of
       the column was lost — in which case the rows are simply the periods in
       order. Both readings are built and the one that actually recognises more
       lessons wins, so a page can never be made worse by trying. */
    const placeDaysCols = periodMap => {
      const g = Array.from({ length: periods }, () => Array.from({ length: days }, () => null));
      const rep = { placed: 0, matched: 0, raw: 0, unmatched: [], cells: [] };
      const rowList = Object.keys(periodMap).map(Number).sort((a, b) => a - b);
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
          rep.cells.push({ r, c, d, slot, text, parsed });
          if (!subjectId && !teacherId) { rep.unmatched.push(text); return; }
          g[slot][d] = { raw: text, subjectId, teacherId, room: parsed.room, score: parsed.score };
          rep.placed++;
          if (subjectId) rep.matched++;
        });
      });
      return { grid: g, report: rep };
    };

    if (model.orientation === "days-cols") {
      let chosen = placeDaysCols(model.periodByRow);
      if (model.dayByCol && Object.keys(model.dayByCol).length >= 2 && model.gridCells) {
        /* Rows that actually hold lessons, in page order. */
        const lessonRows = [];
        (model.gridCells || []).forEach((row, r) => {
          let hits = 0;
          Object.keys(model.dayByCol).forEach(dk => {
            const c = model.dayByCol[dk];
            if (model.periodCol !== null && c === model.periodCol) return;
            const text = cellAt(r, c);
            if (isBlank(text)) return;
            const p = parseCellText(text, ctx);
            if (p.subject || p.teacher) hits++;
          });
          if (hits >= 2) lessonRows.push(r);
        });
        if (lessonRows.length >= 2 && lessonRows.length <= periods) {
          const map = {};
          lessonRows.forEach((r, i) => { map[r] = { period: i + 1, time: null }; });
          const alt = placeDaysCols(map);
          /* Winning on matched lessons is the main test. When both readings
             recognise exactly as many, the one that does not leave the week
             with a hole in the first period is the better layout — that is what
             a stray "4" pushed onto the top row used to cause. */
          const firstSlot = res => {
            for (let p = 0; p < res.grid.length; p++)
              if (res.grid[p].some(c => c && (c.subjectId || c.teacherId))) return p;
            return Infinity;
          };
          if (alt.report.matched > chosen.report.matched ||
              (alt.report.matched === chosen.report.matched && firstSlot(alt) < firstSlot(chosen))) {
            alt.report.assumed = "periods-in-order";
            chosen = alt;
          }
        }
      }
      chosen.grid.forEach((row, p) => row.forEach((cell, d) => { grid[p][d] = cell; }));
      report.placed = chosen.report.placed; report.matched = chosen.report.matched;
      report.unmatched = chosen.report.unmatched; report.cells = chosen.report.cells;
      if (chosen.report.assumed) report.assumed = chosen.report.assumed;
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
  /* Join the pieces of a word that a PDF split into separate text items. Two
     boxes are the same word when they share a line and the gap between them is
     a fraction of the letter height: pieces of one glyph run touch, a real space
     is about a quarter of the height, and a column gutter is wider still — so
     nothing that belongs apart can be merged by mistake. */
  function mergeGlyphRuns(boxes) {
    if (!boxes || boxes.length < 2) return boxes || [];
    const list = boxes.slice().sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));

    /* Work line by line, because how wide a "space" is depends on the line. */
    const lines = [];
    for (const b of list) {
      const line = lines[lines.length - 1];
      const h = Math.max(1, b.y1 - b.y0);
      if (line && Math.abs(b.y0 - line.y0) < Math.max(line.h, h) * 0.5) {
        line.items.push(b);
        line.h = Math.max(line.h, h);
        line.y0 = Math.min(line.y0, b.y0);
      } else {
        lines.push({ y0: b.y0, h, items: [b] });
      }
    }

    const out = [];
    for (const line of lines) {
      const items = line.items;
      /* Two populations of gaps on one line: the small ones are where the file
         SPLIT A WORD ("සඳු" + "දා", "ගණි" + "තය" — old PDF writers emit complex
         scripts this way), the large ones are the real spaces between cells. If
         the line clearly has both, the small ones are joined. A line with evenly
         spaced words has no second population and is left completely alone, so
         ordinary OCR text and spreadsheets are never touched. */
      const gaps = [];
      for (let i = 1; i < items.length; i++) {
        const g = items[i].x0 - items[i - 1].x1;
        if (g > 0) gaps.push(g);
      }
      const sorted = gaps.slice().sort((a, b) => a - b);
      const small = sorted.length ? sorted[Math.floor(sorted.length * 0.25)] : 0;
      const big = sorted.length ? sorted[sorted.length - 1] : 0;
      const twoPopulations = sorted.length >= 3 && small > 0 && big > small * 2.2;
      const limit = twoPopulations
        ? Math.min(Math.max(line.h * 0.14, small * 1.6), line.h * 0.8)
        : line.h * 0.14;

      let current = null;
      for (const b of items) {
        if (current) {
          const h = Math.max(1, Math.min(b.y1 - b.y0, current.y1 - current.y0));
          const sameLine = Math.abs(b.y0 - current.y0) < h * 0.35 && Math.abs(b.y1 - current.y1) < h * 0.45;
          const gap = b.x0 - current.x1;
          const pieces = (current._pieces || 1) + 1;
          if (sameLine && gap > -h * 0.06 && gap < limit && pieces <= 4 && current.text.length + b.text.length <= 18) {
            /* Touching pieces are one word; a small gap is a thin space. */
            current.text = current.text + (gap < h * 0.05 ? "" : " ") + b.text;
            current.x1 = Math.max(current.x1, b.x1);
            current.y0 = Math.min(current.y0, b.y0);
            current.y1 = Math.max(current.y1, b.y1);
            current._pieces = pieces;
            continue;
          }
        }
        current = Object.assign({}, b);
        out.push(current);
      }
    }
    return out.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
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
      let broken = 0, brokenItems = 0, words = 0;
      for (const item of content.items) {
        /* A NUL or replacement character means the font in the file has no
           Unicode mapping — old generators do this, especially for Sinhala and
           Tamil. Count both the characters and the WORDS they landed in: one bad
           letter is a slip, but when a fifth of the words carry one the file
           simply cannot store this script, and its text must not be trusted. */
        const bad = ((item.str || "").match(/[\u0000\ufffd]/g) || []).length;
        if (squash(item.str)) words++;
        if (bad) { broken += bad; brokenItems++; }
        const t = stripWatermarks(squash(item.str));
        if (!t) continue;
        const tr = item.transform;
        const x = tr[4], y = tr[5];
        const h = Math.abs(tr[3]) || Math.abs(item.height) || 10;
        const w = Math.abs(item.width) || t.length * h * 0.5;
        /* PDF y grows upwards; flip it so rows sort top-down like OCR output. */
        boxes.push({ text: t, x0: x, x1: x + w, y0: viewport.height - y - h, y1: viewport.height - y, conf: 1 });
      }
      /* Old generators, and complex-script fonts without a proper Unicode table,
         hand back a word as several glyph runs: "ගණි" and "තය" instead of
         "ගණිතය", "සඳු" and "දා" instead of "සඳුදා". Left alone, the geometry
         sees two extra columns where the page has one word — so the pieces are
         joined back together before any rows or columns are worked out. */
      const merged = mergeGlyphRuns(boxes);
      const grid = merged.length >= 4 ? buildGridFromBoxes(merged) : null;
      const chars = boxes.reduce((n, b) => n + b.text.length, 0);
      const text = boxes.map(b => b.text).join(" ");
      /* Damaged when an eighth of the letters had no Unicode meaning, or when
         there is not enough text to be a timetable. Either way the page is read
         as a picture instead of trusting what came out of the file. */
      /* A file written properly has NO unmapped characters at all, so even a
         few words carrying one means the text cannot be relied on for this
         script — it will read as "විදාව" where the page says "විද්‍යාව". A single
         stray glyph is still tolerated, a twelfth of the words is not. */
      const damaged = chars > 0 && (broken / Math.max(1, chars + broken) > 0.03 ||
        (brokenItems >= 3 && words >= 8 && brokenItems / words > 0.05));
      pages.push({ page: p, boxes: merged, grid, chars, broken, brokenItems, words, damaged,
        script: scriptOf(text), needsOcr: chars < 24 || damaged });
      if (onPage) onPage(p, doc.numPages, chars);
    }
    const usable = pages.filter(p => p.grid && !p.needsOcr);
    const best = usable.sort((a, b) => b.chars - a.chars)[0] || null;
    return {
      kind: "pdf", numPages: doc.numPages, pages,
      best,
      /* Why a page is being read as a picture matters to the person waiting:
         "no text at all" is normal for a scan, a damaged layer means their file
         was written by a program that left the letters out. */
      damaged: !best && pages.some(p => p.damaged && p.chars > 0),
      script: pages.map(p => p.script).sort((a, b) => pages.filter(x => x.script === b).length - pages.filter(x => x.script === a).length)[0] || "",
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
    stripInvisible, matchKey, tightKey, stripWatermarks, scriptOf, mergeGlyphRuns,
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
