// Spike: read-only XLSX on yauzl (already vendored for .lorepack) + sax.
// Proves the four criteria no maintained library met together: cell addresses, formula text,
// merge ranges, and bounded memory at the envelope.
import sax from 'sax';
import yauzl from 'yauzl';

function openZip(path) {
  return new Promise((res, rej) =>
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (e, z) => (e ? rej(e) : res(z))),
  );
}
function entries(zip) {
  const found = new Map();
  return new Promise((res, rej) => {
    zip.on('entry', (en) => {
      found.set(en.fileName, en);
      zip.readEntry();
    });
    zip.on('end', () => res(found));
    zip.on('error', rej);
    zip.readEntry();
  });
}
function stream(zip, entry) {
  return new Promise((res, rej) => zip.openReadStream(entry, (e, s) => (e ? rej(e) : res(s))));
}

/** Streams one XML entry through sax, calling back per element. Never buffers the document. */
async function parseXml(zip, entry, handlers) {
  const parser = sax.createStream(true, { trim: false, position: false });
  // Hardening the spike has to prove is possible: refuse entity expansion outright.
  parser.on('doctype', () => {
    throw new Error('DTD refused');
  });
  if (handlers.open) parser.on('opentag', handlers.open);
  if (handlers.text) parser.on('text', handlers.text);
  if (handlers.close) parser.on('closetag', handlers.close);
  const rs = await stream(zip, entry);
  await new Promise((res, rej) => {
    parser.on('end', res);
    parser.on('error', rej);
    rs.on('error', rej);
    rs.pipe(parser);
  });
}

const path = process.argv[2] ?? 'fixture-small.xlsx';
const sheetWanted = process.argv[3] ?? null;
const started = Date.now();
let peak = 0;
const tick = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage.rss());
}, 50);

const zip = await openZip(path);
const found = await entries(zip);

// Shared strings, the one table we must hold. Bounded by the file's own string count.
const shared = [];
if (found.has('xl/sharedStrings.xml')) {
  let inSi = false,
    buf = '';
  await parseXml(zip, found.get('xl/sharedStrings.xml'), {
    open: (n) => {
      if (n.name === 'si') {
        inSi = true;
        buf = '';
      }
    },
    text: (t) => {
      if (inSi) buf += t;
    },
    close: (name) => {
      if (name === 'si') {
        shared.push(buf);
        inSi = false;
      }
    },
  });
}

// Number formats, so an Excel date serial can be told from a plain number.
const numFmtOfXf = [];
const dateFmtIds = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const customDateFmt = new Set();
if (found.has('xl/styles.xml')) {
  let inCellXfs = false;
  await parseXml(zip, found.get('xl/styles.xml'), {
    open: (n) => {
      if (n.name === 'cellXfs') inCellXfs = true;
      else if (n.name === 'xf' && inCellXfs) numFmtOfXf.push(Number(n.attributes.numFmtId ?? 0));
      else if (n.name === 'numFmt') {
        const code = String(n.attributes.formatCode ?? '');
        if (/[dmyhs]/i.test(code.replace(/\[[^\]]*\]|"[^"]*"/g, ''))) {
          customDateFmt.add(Number(n.attributes.numFmtId));
        }
      }
    },
    close: (name) => {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
}
const isDateStyle = (s) => {
  const id = numFmtOfXf[Number(s ?? 0)] ?? 0;
  return dateFmtIds.has(id) || customDateFmt.has(id);
};

// Sheet names, in workbook order.
const sheetNames = [];
if (found.has('xl/workbook.xml')) {
  await parseXml(zip, found.get('xl/workbook.xml'), {
    open: (n) => {
      if (n.name === 'sheet') sheetNames.push(String(n.attributes.name));
    },
  });
}

const sheetEntries = [...found.keys()]
  .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
  .sort();
const target = sheetWanted
  ? (sheetEntries[sheetNames.indexOf(sheetWanted)] ?? sheetEntries[0])
  : sheetEntries[0];

let rows = 0,
  cells = 0,
  formulas = 0;
const merges = [];
const sample = [];
let cur = null,
  inV = false,
  inF = false,
  vbuf = '',
  fbuf = '';

await parseXml(zip, found.get(target), {
  open: (n) => {
    if (n.name === 'row') rows += 1;
    else if (n.name === 'c') {
      cur = { ref: n.attributes.r, t: n.attributes.t, s: n.attributes.s };
      vbuf = '';
      fbuf = '';
    } else if (n.name === 'v') inV = true;
    else if (n.name === 'f') inF = true;
    else if (n.name === 'mergeCell') merges.push(String(n.attributes.ref));
  },
  text: (t) => {
    if (inV) vbuf += t;
    else if (inF) fbuf += t;
  },
  close: (name) => {
    if (name === 'v') inV = false;
    else if (name === 'f') inF = false;
    else if (name === 'c' && cur) {
      cells += 1;
      if (fbuf) formulas += 1;
      if (sample.length < 12) {
        let value, kind;
        if (cur.t === 's') {
          value = shared[Number(vbuf)];
          kind = 'string';
        } else if (cur.t === 'b') {
          value = vbuf === '1';
          kind = 'boolean';
        } else if (cur.t === 'inlineStr' || cur.t === 'str') {
          value = vbuf;
          kind = 'string';
        } else if (vbuf === '') {
          value = null;
          kind = 'empty';
        } else if (isDateStyle(cur.s)) {
          // Excel serial, 1900 system, with the historical leap-year bug accounted for.
          value = new Date(Date.UTC(1899, 11, 30) + Number(vbuf) * 86400000)
            .toISOString()
            .slice(0, 10);
          kind = 'date';
        } else {
          value = Number(vbuf);
          kind = 'number';
        }
        sample.push(`${cur.ref}=${kind}:${JSON.stringify(value)}${fbuf ? ' F:' + fbuf : ''}`);
      }
      cur = null;
    }
  },
});
zip.close();
clearInterval(tick);
peak = Math.max(peak, process.memoryUsage.rss());
console.log(
  JSON.stringify(
    {
      library: 'own reader (yauzl + sax)',
      file: path,
      sheet: sheetWanted ?? sheetNames[0],
      sheetNames,
      rows,
      cells,
      formulas,
      merges,
      seconds: +((Date.now() - started) / 1000).toFixed(1),
      peakRssMB: Math.round(peak / 1048576),
      sample,
    },
    null,
    2,
  ),
);
