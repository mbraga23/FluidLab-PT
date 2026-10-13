// PDF export gate.
//
// export.js is deliberately split into a DOM-free core (shapes-as-data in, PDF bytes out)
// and a thin DOM-walking collector (collectShapes) — see the "PDF export" section of
// src/export.js. Only the core is testable under plain Node (no DOM here), which is
// exactly the part where a handwritten PDF writer actually breaks: byte offsets that
// drift, escaping that doesn't survive the `(...)` literal, arcs and quadratics that were
// never converted, a y-axis nobody flipped. Those are what this file checks.
//
// Run headless:  node tests/run.js

import {
  escapePdfText, pageBox, makeTransform, toPdfPoint, buildPDF, buildPdfFromShapes,
  shapesToContentStream,
} from '../src/export.js';

export const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const close = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (Toleranz ${tol})`);

/** Uint8Array -> binary string, the same convention buildPDF() writes internally
 * (one JS char code per byte), so tests can search/slice PDF bytes like text. */
const bytesToStr = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

// ---------------------------------------------------------------------------
// The writer itself: header, xref, trailer
// ---------------------------------------------------------------------------

test('PDF: Bytes beginnen mit %PDF- und enden mit %%EOF', () => {
  const bytes = buildPDF([{ width: 200, height: 100, content: '0 0 0 RG\n0 0 m 10 10 l S\n' }]);
  const str = bytesToStr(bytes);
  assert(str.startsWith('%PDF-'), `Header fehlt: "${str.slice(0, 20)}"`);
  assert(str.endsWith('%%EOF'), `kein %%EOF am Ende: "${str.slice(-20)}"`);
});

test('PDF: xref-Tabelle zeigt für jedes Objekt auf den echten Byte-Offset', () => {
  // Two pages (drawing + a parts page) so the object count is non-trivial: Catalog,
  // Pages, 2x(Page,Contents), 2x Font = 8 objects — enough that an off-by-one in the id
  // allocation or the offset bookkeeping would show up as a mismatch somewhere in there.
  const bytes = buildPDF([
    { width: 300, height: 200, content: '1 0 0 RG\n0 0 m 10 10 l S\n' },
    { width: 300, height: 200, content: 'BT /F1 9 Tf 1 0 0 1 10 10 Tm (x) Tj ET\n' },
  ]);
  const str = bytesToStr(bytes);

  const xrefAt = str.indexOf('\nxref\n');
  assert(xrefAt >= 0, 'kein xref-Abschnitt gefunden');
  const lines = str.slice(xrefAt + 1).split('\n');
  assert(lines[0] === 'xref', 'xref-Header an falscher Position');
  const [, countStr] = lines[1].split(' ');
  const count = Number(countStr);
  assert(count === 9, `erwartete 8 Objekte + Objekt 0, war ${count}`); // Catalog, Pages, 2x(Page+Contents), 2 Fonts

  let checked = 0;
  for (let id = 1; id < count; id++) {
    const entry = lines[2 + id];
    assert(/^\d{10} \d{5} n $/.test(entry), `xref-Eintrag ${id} hat falsches Format: "${entry}"`);
    const offset = Number(entry.slice(0, 10));
    const marker = `${id} 0 obj`;
    const atOffset = str.slice(offset, offset + marker.length);
    assert(atOffset === marker, `Objekt ${id}: xref zeigt auf Offset ${offset}, dort steht aber "${atOffset}"`);
    checked++;
  }
  assert(checked === 8, `zu wenige Objekte geprüft (${checked})`);
});

test('PDF: Trailer verweist auf den Catalog und die Startxref-Position stimmt', () => {
  const bytes = buildPDF([{ width: 100, height: 100, content: 'S\n' }]);
  const str = bytesToStr(bytes);
  assert(/\/Root 1 0 R/.test(str), 'Trailer referenziert nicht Objekt 1 als Root');
  const m = str.match(/startxref\n(\d+)\n%%EOF$/);
  assert(m, 'startxref-Zeile fehlt oder falsch platziert');
  const claimed = Number(m[1]);
  const actual = str.indexOf('\nxref\n') + 1;
  assert(claimed === actual, `startxref zeigt auf ${claimed}, xref beginnt aber bei ${actual}`);
});

// ---------------------------------------------------------------------------
// Page geometry: A4/A3, quer/hoch
// ---------------------------------------------------------------------------

test('Seitenformat: A4 und A3, quer und hoch, liefern die genormten pt-Maße', () => {
  const cases = [
    ['a4', 'portrait', 595.28, 841.89],
    ['a4', 'landscape', 841.89, 595.28],
    ['a3', 'portrait', 841.89, 1190.55],
    ['a3', 'landscape', 1190.55, 841.89],
  ];
  for (const [format, orientation, w, h] of cases) {
    const box = pageBox(format, orientation);
    close(box.width, w, 0.01, `${format} ${orientation} Breite`);
    close(box.height, h, 0.01, `${format} ${orientation} Höhe`);
  }
});

test('Seitenformat schlägt bis in die erzeugten Bytes durch (MediaBox)', () => {
  const bbox = { x: 0, y: 0, w: 10, h: 10 };
  const bytes = buildPdfFromShapes([], bbox, { format: 'a3', orientation: 'portrait', title: 'x' });
  const str = bytesToStr(bytes);
  assert(str.includes('/MediaBox [0 0 841.89 1190.55]'), 'MediaBox entspricht nicht A3 hoch');
});

// ---------------------------------------------------------------------------
// Text escaping
// ---------------------------------------------------------------------------

test('Text-Escaping: Klammern und Backslash überleben die (...)-Literal-Syntax', () => {
  const escaped = escapePdfText('1A1: Zylinder (Ø25) \\ Rückschlag');
  assert(escaped.includes('\\('), 'öffnende Klammer nicht escaped');
  assert(escaped.includes('\\)'), 'schließende Klammer nicht escaped');
  assert(escaped.includes('\\\\'), 'Backslash nicht escaped');

  // The bug an unescaped ')' actually causes: it terminates the PDF string literal early,
  // so every unescaped paren must be matched by a preceding backslash. Walk the escaped
  // string and confirm no *unescaped* paren remains.
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '\\') { i++; continue; }
    assert(escaped[i] !== '(' && escaped[i] !== ')', `unescaped "${escaped[i]}" an Position ${i}`);
  }
});

test('Text-Escaping: deutsche Umlaute landen auf ihren WinAnsi/Latin-1-Bytes', () => {
  // WinAnsiEncoding matches Latin-1 exactly in this range, so Ö/ä/ß map straight to their
  // Unicode code points as raw bytes — no lookup table needed for German text specifically.
  const cases = [['Ö', 0xd6], ['ä', 0xe4], ['ß', 0xdf], ['ü', 0xfc], ['Ä', 0xc4],
    ['ã', 0xe3], ['ç', 0xe7], ['é', 0xe9], ['ô', 0xf4], ['Á', 0xc1]];
  for (const [ch, byte] of cases) {
    assert(escapePdfText(ch).charCodeAt(0) === byte, `${ch} muss auf 0x${byte.toString(16)} abgebildet werden`);
  }
});

test('Text-Escaping in einer echten Stückliste bricht die Datei nicht', () => {
  // A tag or spec containing parens/backslash used to be exactly the input that produces
  // a truncated, unparseable PDF from a naive writer — reproduce it end to end.
  const partsRows = [{
    def: { name: 'Drosselrückschlagventil (Zuluft)', group: 'Stromventile\\Spezial' },
    spec: '0,4 mm', tags: ['1V1'], count: 1, domain: 1,
  }];
  const bytes = buildPdfFromShapes([], { x: 0, y: 0, w: 10, h: 10 }, { title: 'Test (V2)', partsRows });
  const str = bytesToStr(bytes);
  assert(str.startsWith('%PDF-') && str.endsWith('%%EOF'), 'Datei wurde durch Sonderzeichen zerstört');
  assert(str.includes('/Count 2'), 'Stücklisten-Seite wurde nicht angehängt');
});

// ---------------------------------------------------------------------------
// Coordinate transform: SVG y-down -> PDF y-up
// ---------------------------------------------------------------------------

test('Koordinatentransformation: bekannte Punkte, SVG-unten wird PDF-oben', () => {
  const bbox = { x: 0, y: 0, w: 100, h: 50 };
  const page = { width: 800, height: 600 };
  const t = makeTransform(bbox, page, { margin: 0, titleH: 0 });

  close(t.scale, 8, 1e-9, 'Skalierung = min(800/100, 600/50)');

  const [x0, y0] = toPdfPoint(t, 0, 0); // top-left of the SVG content
  close(x0, 0, 1e-9, 'linker Rand landet bei x=0');
  close(y0, 500, 1e-9, 'SVG-oben (y=0) landet bei PDF y=500 (vertikal zentriert)');

  const [x1, y1] = toPdfPoint(t, 100, 50); // bottom-right of the SVG content
  close(x1, 800, 1e-9, 'rechter Rand landet bei x=800');
  close(y1, 100, 1e-9, 'SVG-unten (y=50) landet bei PDF y=100, unterhalb von y0');

  assert(y1 < y0, 'ein größeres SVG-y muss auf ein kleineres PDF-y abgebildet werden (Flip)');

  const [, yMid] = toPdfPoint(t, 50, 25);
  close(yMid, 300, 1e-9, 'Mittelpunkt liegt exakt zwischen oberem und unterem Rand');
});

test('Koordinatentransformation: mit Rand und Schriftfeld verschiebt sich nur die Zuordnung, nicht die Richtung', () => {
  const bbox = { x: 10, y: 10, w: 100, h: 100 }; // non-zero bbox origin, as a real sheet has
  const page = { width: 500, height: 500 };
  const t = makeTransform(bbox, page, { margin: 20, titleH: 40 });
  const [, yTop] = toPdfPoint(t, 10, 10); // top of content
  const [, yBottom] = toPdfPoint(t, 10, 110); // bottom of content
  assert(yTop > yBottom, 'Inhalt oben in SVG muss oben (größeres y) in PDF landen');
  // The title block strip (titleH=40) must stay clear beneath the drawing.
  assert(yBottom >= 20 + 40 - 1e-6, `Inhalt reicht in das Schriftfeld hinein: unterer Rand bei ${yBottom}`);
});

// ---------------------------------------------------------------------------
// Shape geometry: the SVG-shape -> PDF-path converter
// ---------------------------------------------------------------------------

test('Formen-Konverter: line/rect/circle/polygon/path erzeugen gültige Pfadoperatoren', () => {
  const page = { width: 200, height: 200 };
  const bbox = { x: 0, y: 0, w: 100, h: 100 };
  const t = makeTransform(bbox, page, { margin: 0, titleH: 0 });
  const shapes = [
    { type: 'line', x1: 0, y1: 0, x2: 10, y2: 10, M: IDENTITY, cls: 'sym' },
    { type: 'rect', x: 0, y: 0, w: 20, h: 10, M: IDENTITY, cls: 'sym fill' },
    { type: 'circle', cx: 5, cy: 5, r: 3, M: IDENTITY, cls: 'sym barrel' },
    { type: 'polygon', points: [[0, 0], [5, 0], [2.5, 5]], M: IDENTITY, cls: 'sym fill' },
    // The exact arc used by the RS-flip-flop symbol in src/catalog.js.
    { type: 'path', d: 'M 24 17 A 6 6 0 0 1 24 27 Z', M: IDENTITY, cls: 'sym' },
    { type: 'path', d: 'M 24 10 Q 29 15 34 10', M: IDENTITY, cls: 'sym thin' },
    { type: 'text', x: 10, y: 10, text: 'P', anchor: 'middle', M: IDENTITY, cls: 'sym-port' },
  ];
  const ops = shapesToContentStream(shapes, t);
  assert(ops.includes(' m\n'), 'kein moveto erzeugt');
  assert(ops.includes(' l\n'), 'kein lineto für die Linie/das Rechteck erzeugt');
  assert(ops.includes(' c\n'), 'kein curveto für Kreis/Bogen/Quadratik erzeugt');
  assert(ops.includes('(P) Tj'), 'Text wurde nicht gerendert');
  assert(/\n[SBf]\n/.test(ops), 'kein Paint-Operator erzeugt');
});

test('Formen-Konverter: der Bogen (A) beginnt und endet exakt an den SVG-Endpunkten', () => {
  // Import the arc converter indirectly by rendering a path shape and checking the first
  // "m" and last "c" endpoint against the known SVG start/end points — a black-box check
  // that does not need arcToCubics exported, but still catches a broken parameterisation.
  const page = { width: 100, height: 100 };
  const bbox = { x: 0, y: 0, w: 40, h: 40 };
  const t = makeTransform(bbox, page, { margin: 0, titleH: 0 });
  const shapes = [{ type: 'path', d: 'M 24 17 A 6 6 0 0 1 24 27 Z', M: IDENTITY, cls: 'sym' }];
  const ops = shapesToContentStream(shapes, t);
  const startPdf = toPdfPoint(t, 24, 17);
  const endPdf = toPdfPoint(t, 24, 27);
  const mMatch = ops.match(/([-\d.]+) ([-\d.]+) m/);
  close(Number(mMatch[1]), startPdf[0], 0.02, 'Bogen-Start x');
  close(Number(mMatch[2]), startPdf[1], 0.02, 'Bogen-Start y');
  const cMatches = [...ops.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) c/g)];
  assert(cMatches.length > 0, 'Bogen wurde nicht in Kurven konvertiert');
  const last = cMatches[cMatches.length - 1];
  close(Number(last[5]), endPdf[0], 0.02, 'Bogen-Ende x');
  close(Number(last[6]), endPdf[1], 0.02, 'Bogen-Ende y');
});

test('Formen-Konverter: eine um 90° rotierte Gruppe transformiert Ports mit, nicht nur Symbole', () => {
  // Mirrors how main.js places a part: transform="translate(tx,ty) rotate(90,cx,cy)" on
  // the wrapping <g>. A shape's M here plays exactly that role — this test is the reason
  // collectShapes() bothers walking nested <g transform> at all.
  const rot90 = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 }; // pure 90° rotation about the origin
  const page = { width: 200, height: 200 };
  const bbox = { x: -10, y: -10, w: 20, h: 20 };
  const t = makeTransform(bbox, page, { margin: 0, titleH: 0 });
  // A unit line along +x in local space should come out along +y in local space after the
  // rotation, i.e. its local endpoint (1,0) maps through M to (0,1) before the page transform.
  const shapes = [{ type: 'line', x1: 0, y1: 0, x2: 1, y2: 0, M: rot90, cls: 'sym' }];
  const ops = shapesToContentStream(shapes, t);
  const lMatch = ops.match(/([-\d.]+) ([-\d.]+) l/);
  const expected = toPdfPoint(t, 0, 1); // rot90 sends local (1,0) -> content-space (0,1)
  close(Number(lMatch[1]), expected[0], 0.02, 'rotierter Endpunkt x');
  close(Number(lMatch[2]), expected[1], 0.02, 'rotierter Endpunkt y');
});

// ---------------------------------------------------------------------------
// End to end: an empty/absent sheet must not crash, a real-shaped one must round-trip
// ---------------------------------------------------------------------------

test('buildPdfFromShapes: leere Formenliste erzeugt trotzdem eine gültige, minimale PDF-Datei', () => {
  const bytes = buildPdfFromShapes([], { x: 0, y: 0, w: 1, h: 1 }, { title: 'Leer' });
  const str = bytesToStr(bytes);
  assert(str.startsWith('%PDF-') && str.endsWith('%%EOF'), 'leere Zeichnung erzeugt keine gültige Datei');
  assert(str.includes('/Count 1'), 'ohne Stückliste darf nur eine Seite entstehen');
});

test('PDF-Text: Zeichen ohne WinAnsi-Entsprechung werden lesbar ersetzt, nicht zu „?“', async () => {
  const { escapePdfText } = await import('../src/export.js');
  const b = (s) => [...escapePdfText(s)].map((c) => c.charCodeAt(0));

  // U+2212 MINUS SIGN is not U+002D HYPHEN and has no WinAnsi codepoint. Every example
  // title in this project uses it ("A+ B+ A− B−"), and it printed as "?" until mapped.
  assert(escapePdfText('A−B') === 'A-B', `Minuszeichen muss zum Bindestrich werden, war „${escapePdfText('A−B')}“`);
  assert(!escapePdfText('A− B−').includes('?'), 'Kein Fragezeichen im ersetzten Text');

  // Arrows appear in GRAFCET receptivities (↑S1), Δ in the cursor readout.
  assert(escapePdfText('↑S1') === '^S1', `Flankenpfeil: war „${escapePdfText('↑S1')}“`);
  assert(escapePdfText('Δt') === 'Dt', `Delta: war „${escapePdfText('Δt')}“`);

  // What WinAnsi genuinely has must still map to its real codepoint, not to ASCII.
  assert(b('–')[0] === 0x96, 'Gedankenstrich muss auf den echten WinAnsi-Punkt gehen');
  assert(b('·')[0] === 0xb7, 'Mittelpunkt ist in WinAnsi vorhanden');
  assert(b('ä')[0] === 0xe4 && b('ß')[0] === 0xdf, 'Umlaute bleiben Latin-1');

  // Escaping still has to survive the substitution.
  assert(escapePdfText('(a\\b)') === '\\(a\\\\b\\)', 'Klammern und Backslash bleiben escaped');
  return {
    minus: `„A− B−“ → „${escapePdfText('A− B−')}“`,
    pfeil: `„↑S1“ → „${escapePdfText('↑S1')}“`,
  };
});
