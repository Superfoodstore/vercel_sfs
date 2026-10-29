// /api/channable-images
// Haalt de Channable image-CSV (HP/UP/VK per variant-ID) op en voegt daar de
// image-URL's uit de Mattisson- en Vitakruid-XML-feeds aan toe als extra kolommen.
// Sidekick haalt alleen dit endpoint op, zonder parameters.
//
// Koppeling gebeurt op EAN: de CSV moet daarvoor een kolom "ean", "barcode" of
// "gtin" bevatten. Zonder zo'n kolom blijven de extra kolommen leeg en komt de
// CSV verder ongewijzigd door.

const BASE_CSV_URL = 'https://files.channable.com/tmHcKnBkHDcQnUiK21laAw==.csv';

const XML_FEEDS = [
  {
    name: 'mattisson',
    url: 'https://files.channable.com/dh565xHHJcCoEgwW7uW2Ew==.xml',
    eanTag: 'ean',
    imageTags: ['image_link', 'additional_image_link'],
    columnPrefix: 'mt_image_',
    maxImages: 3,
  },
  {
    name: 'vitakruid',
    url: 'https://files.channable.com/u92HPRhnF7tadBKid_Xw_A==.xml',
    eanTag: 'eanbar_code',
    imageTags: ['image_link', 'additional_image_link'],
    columnPrefix: 'vkfeed_image_',
    maxImages: 12,
  },
];

const EAN_COLUMN_CANDIDATES = ['ean', 'barcode', 'gtin'];

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; SuperfoodstoreBot/1.0)',
  Accept: 'text/csv,application/xml,text/xml,text/plain,*/*',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

// ---------- helpers ----------

function normalizeEan(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^0+/, '');
  return digits || null;
}

function decodeXmlEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

// Simpele RFC 4180 CSV-parser (quotes, escaped quotes, newlines in velden)
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function csvEscape(v) {
  return '"' + String(v ?? '').replace(/"/g, '""') + '"';
}

// Leest platte Channable-XML (<items><item>…</item></items>) uit naar EAN → [urls]
function parseImageXml(xml, feed) {
  const map = new Map();
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const eanMatch = block.match(new RegExp(`<${feed.eanTag}>([\\s\\S]*?)</${feed.eanTag}>`));
    const ean = eanMatch && normalizeEan(decodeXmlEntities(eanMatch[1]));
    if (!ean) continue;

    const urls = [];
    for (const tag of feed.imageTags) {
      const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
      let t;
      while ((t = re.exec(block))) {
        const url = decodeXmlEntities(t[1]);
        if (url && !urls.includes(url)) urls.push(url);
      }
    }
    if (urls.length) map.set(ean, urls.slice(0, feed.maxImages));
  }
  return map;
}

async function fetchText(url) {
  const r = await fetch(url, { headers: FETCH_HEADERS });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.text();
}

// ---------- handler ----------

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const warnings = [];

  try {
    const [csvResult, ...xmlResults] = await Promise.allSettled([
      fetchText(BASE_CSV_URL),
      ...XML_FEEDS.map((f) => fetchText(f.url)),
    ]);

    // Zonder de basis-CSV heeft het geen zin
    if (csvResult.status !== 'fulfilled') {
      return res.status(502).json({ error: `Base CSV failed: ${csvResult.reason?.message}` });
    }

    const rows = parseCsv(csvResult.value);
    const header = rows[0];
    const dataRows = rows.slice(1);

    const eanIdx = header.findIndex((h) => EAN_COLUMN_CANDIDATES.includes(h.trim().toLowerCase()));
    if (eanIdx === -1) warnings.push('no EAN column in base CSV; extra columns left empty');

    // XML-feeds inlezen; een mislukte feed geeft lege kolommen, geen fout
    const feedMaps = XML_FEEDS.map((feed, i) => {
      const r = xmlResults[i];
      if (r.status !== 'fulfilled') {
        warnings.push(`${feed.name} feed failed: ${r.reason?.message}`);
        return new Map();
      }
      return parseImageXml(r.value, feed);
    });

    // Extra kolommen achteraan, zodat bestaande kolomposities niet verschuiven
    const extraHeader = XML_FEEDS.flatMap((feed) =>
      Array.from({ length: feed.maxImages }, (_, n) => `${feed.columnPrefix}${n + 1}`)
    );

    const out = [[...header, ...extraHeader].map(csvEscape).join(',')];
    const matched = XML_FEEDS.map(() => 0);

    for (const row of dataRows) {
      const ean = eanIdx === -1 ? null : normalizeEan(row[eanIdx]);
      const extra = XML_FEEDS.flatMap((feed, i) => {
        const urls = (ean && feedMaps[i].get(ean)) || [];
        if (urls.length) matched[i]++;
        return Array.from({ length: feed.maxImages }, (_, n) => urls[n] || '');
      });
      out.push([...row, ...extra].map(csvEscape).join(','));
    }

    res.setHeader(
      'X-Feed-Stats',
      XML_FEEDS.map((f, i) => `${f.name}=${matched[i]}/${feedMaps[i].size}`).join('; ')
    );
    if (warnings.length) res.setHeader('X-Feed-Warnings', warnings.join(' | '));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).send(out.join('\n') + '\n');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
