// api/awin-costs.js — Awin-kosten per dag als CSV voor het kostendashboard.
//
// Env vars (Vercel → Settings → Environment Variables):
//   AWIN_API_TOKEN       OAuth2-token uit ui.awin.com → API credentials
//   AWIN_ADVERTISER_ID   jullie advertiser-ID (zie GET https://api.awin.com/accounts)
//   AWIN_OVERRIDE_PCT    Awin-netwerkfee bovenop de publisher-commissie, bv. 30 (optioneel, default 0)
//   AWIN_PROXY_KEY       sleutel voor deze endpoint (valt terug op SHOPSTATS_PROXY_KEY)
//
// Aanroep: /api/awin-costs?key=...&start=2026-09-01&end=2026-09-30[&format=csv|json][&override=30]

const API = "https://api.awin.com";
const TZ = "Europe/Berlin"; // zelfde tijdzone als Amsterdam; Awin accepteert een vaste lijst zones
const COUNTED = new Set(["pending", "approved"]); // declined/deleted tellen niet als kosten

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const addDays = (d, n) => {
  const t = new Date(d + "T12:00:00Z");
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const r2 = (v) => Math.round(v * 100) / 100;

async function fetchChunk(adv, token, from, to) {
  const u = new URL(`${API}/advertisers/${adv}/transactions/`);
  u.searchParams.set("startDate", `${from}T00:00:00`);
  u.searchParams.set("endDate", `${to}T23:59:59`);
  u.searchParams.set("timezone", TZ);
  u.searchParams.set("dateType", "transaction");
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw Object.assign(new Error("Awin rate limit bereikt, probeer het over een minuut opnieuw."), { status: 429 });
  if (!res.ok) throw Object.assign(new Error(`Awin API ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: 502 });
  return res.json();
}

export default async function handler(req, res) {
  const q = req.query || {};
  const expected = process.env.AWIN_PROXY_KEY || process.env.SHOPSTATS_PROXY_KEY;
  if (!expected || q.key !== expected) return res.status(401).json({ error: "Ongeldige of ontbrekende key." });

  const token = process.env.AWIN_API_TOKEN, adv = process.env.AWIN_ADVERTISER_ID;
  if (!token || !adv) return res.status(500).json({ error: "AWIN_API_TOKEN of AWIN_ADVERTISER_ID ontbreekt." });

  const start = q.start, end = q.end;
  if (!isDate(start) || !isDate(end) || start > end) return res.status(400).json({ error: "Geef start en end als JJJJ-MM-DD." });
  if (addDays(start, 366) < end) return res.status(400).json({ error: "Maximaal een jaar per aanvraag." });

  const override = Number(q.override ?? process.env.AWIN_OVERRIDE_PCT ?? 0) || 0;

  // Eén rij per dag, ook dagen zonder transacties (zo weet het dashboard dat de dag 0 kostte).
  const days = {};
  for (let d = start; d <= end; d = addDays(d, 1))
    days[d] = { date: d, transactions: 0, revenue: 0, commission: 0, declined: 0, pendingCommission: 0 };

  try {
    // Awin staat maximaal 31 dagen per aanvraag toe.
    for (let from = start; from <= end; from = addDays(from, 31)) {
      const to = addDays(from, 30) < end ? addDays(from, 30) : end;
      const list = await fetchChunk(adv, token, from, to);
      for (const t of Array.isArray(list) ? list : []) {
        const d = String(t.transactionDate || "").slice(0, 10);
        const row = days[d];
        if (!row) continue;
        const status = String(t.commissionStatus || "").toLowerCase();
        if (!COUNTED.has(status)) { row.declined++; continue; }
        const comm = Number(t.commissionAmount?.amount) || 0;
        row.transactions++;
        row.revenue += Number(t.saleAmount?.amount) || 0;
        row.commission += comm;
        if (status === "pending") row.pendingCommission += comm;
      }
    }
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message });
  }

  const rows = Object.values(days).map((r) => ({
    ...r,
    revenue: r2(r.revenue),
    commission: r2(r.commission),
    pendingCommission: r2(r.pendingCommission),
    costs: r2(r.commission * (1 + override / 100)),
  }));

  res.setHeader("Cache-Control", "no-store");
  if (q.format === "json") return res.status(200).json({ start, end, overridePct: override, rows });

  const head = "Datum;Transacties;Omzet;Commissie;Waarvan pending;Override %;Kosten;Afgekeurd";
  const lines = rows.map((r) =>
    [r.date, r.transactions, r.revenue, r.commission, r.pendingCommission, override, r.costs, r.declined].join(";"));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="awin-${start}_${end}.csv"`);
  return res.status(200).send([head, ...lines].join("\n"));
}
