// api/beslist-shopstats.js
//
// Proxy voor de beslist.nl Shop Statistics API v3 (https://shopstats.api.beslist.nl/).
// Authenticatie: merchant API key als Bearer token (geen OAuth/Asgardeo meer).
//
// Environment variables (Vercel → Settings → Environment Variables):
//   BESLIST_SHOPSTATS_API_KEY  Merchant API key van beslist.nl (uitgegeven via /api-key)
//   SHOPSTATS_PROXY_KEY      Zelfgekozen lange random string; beschermt dit endpoint
//
// Query-parameters:
//   key       verplicht, = SHOPSTATS_PROXY_KEY
//   date      één dag (YYYY-MM-DD of YYYYMMDD)             → /stats/v3/{date}
//   start,end periode (YYYY-MM-DD of YYYYMMDD)             → zie mode
//   mode      "total" (standaard): één opgetelde rij voor de hele periode
//             "daily": één rij per dag (max 93 dagen), handig voor tijdreeksen
//   category  "1" → uitsplitsen per biedcategorie (include=category)
//   format    "json" (standaard) of "csv" (puntkomma, Nederlandse kolomkoppen)
//   Zonder date/start/end: gisteren.
//
// Voorbeelden:
//   /api/beslist-shopstats?key=...&start=2026-08-01&end=2026-08-31&category=1&format=csv
//   /api/beslist-shopstats?key=...&start=2026-09-01&end=2026-09-28&mode=daily&format=csv

const BASE = "https://shopstats.api.beslist.nl/stats/v3";
const MAX_DAILY_DAYS = 93;

async function shopstats(path, withCategory) {
  const apiKey = process.env.BESLIST_SHOPSTATS_API_KEY;
  if (!apiKey) throw new Error("BESLIST_SHOPSTATS_API_KEY ontbreekt");

  const url = new URL(`${BASE}${path}`);
  if (withCategory) url.searchParams.set("include", "category");

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    const err = new Error(`Shopstats ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    err.status = resp.status === 400 ? 400 : 502;
    throw err;
  }
  const json = await resp.json();
  return json.data || [];
}

// "2026-08-01" of "20260801" → Date (UTC)
function parseDate(s) {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(s || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d) ? null : d;
}
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const iso = (d) => d.toISOString().slice(0, 10);

function yesterdayAmsterdam() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
  const d = parseDate(today);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

// Kleine concurrency-limiet zodat we beslist.nl niet met 90 gelijktijdige calls bestoken.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function toRow(r, periodLabel) {
  const costs = Number(r.costs) || 0;
  const revenue = Number(r.revenue) || 0;
  const transactions = Number(r.transactions) || 0;
  const clicks = Number(r.clicks) || 0;
  return {
    datum: r.date || periodLabel,
    categorie_id: r.category?.id ?? "",
    categorie: r.category?.name ?? "",
    categorie_type: r.category?.type ?? "",
    kliks: clicks,
    transacties: transactions,
    omzet: revenue,
    kosten: costs,
    kosten_per_klik: clicks ? costs / clicks : null,
    kosten_per_transactie: transactions ? costs / transactions : null,
    conversieratio: clicks ? transactions / clicks : null,
    roas: costs ? revenue / costs : null,
  };
}

const HEADERS = {
  datum: "Datum/periode",
  categorie_id: "Categorie-ID",
  categorie: "Biedcategorie",
  categorie_type: "Categorietype",
  kliks: "Kliks",
  transacties: "Transacties",
  omzet: "Omzet",
  kosten: "Kosten",
  kosten_per_klik: "Kosten per klik",
  kosten_per_transactie: "Kosten per transactie",
  conversieratio: "Conversieratio",
  roas: "ROAS",
};

function toCsv(rows, withCategory) {
  const cols = Object.keys(HEADERS).filter((c) => withCategory || !c.startsWith("categorie"));
  const fmt = (v) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(".", ",");
    const s = String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => HEADERS[c]).join(";"), ...rows.map((r) => cols.map((c) => fmt(r[c])).join(";"))].join("\n");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Alleen GET" });

  const { key, date, start, end, mode = "total", category, format = "json" } = req.query;
  const expected = process.env.SHOPSTATS_PROXY_KEY;
  if (!expected || key !== expected) return res.status(401).json({ error: "Ongeldige of ontbrekende key" });

  const withCategory = category === "1" || category === "true";
  const yesterday = yesterdayAmsterdam();

  try {
    let rows;

    if (start || end) {
      const s = parseDate(start);
      let e = parseDate(end) || yesterday;
      if (!s) return res.status(400).json({ error: "start ontbreekt of is ongeldig" });
      if (e > yesterday) e = yesterday; // API accepteert alleen datums in het verleden
      if (s > e) return res.status(400).json({ error: "start ligt na end (of end is niet in het verleden)" });

      if (mode === "daily") {
        const days = [];
        for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) days.push(new Date(d));
        if (days.length > MAX_DAILY_DAYS) {
          return res.status(400).json({ error: `mode=daily is beperkt tot ${MAX_DAILY_DAYS} dagen` });
        }
        const perDay = await mapLimit(days, 5, (d) => shopstats(`/${ymd(d)}`, withCategory));
        rows = perDay.flatMap((data, i) => data.map((r) => toRow({ ...r, date: r.date || iso(days[i]) })));
      } else {
        const label = `${iso(s)} t/m ${iso(e)}`;
        rows = (await shopstats(`/${ymd(s)}/${ymd(e)}`, withCategory)).map((r) => toRow(r, label));
      }
    } else {
      const d = date ? parseDate(date) : yesterday;
      if (!d) return res.status(400).json({ error: "date is ongeldig" });
      rows = (await shopstats(`/${ymd(d)}`, withCategory)).map((r) => toRow({ ...r, date: r.date || iso(d) }));
    }

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.status(200).send("\uFEFF" + toCsv(rows, withCategory));
    }
    return res.status(200).json({ data: rows });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
}
