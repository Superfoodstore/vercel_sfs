// api/awin-costs.js — Awin-kosten per dag als CSV voor het kostendashboard.
//
// Env vars (Vercel → Settings → Environment Variables):
//   AWIN_API_TOKEN       OAuth2-token uit ui.awin.com → API credentials
//   AWIN_ADVERTISER_ID   jullie advertiser-ID (zie GET https://api.awin.com/accounts)
//   AWIN_OVERRIDE_PCT    Awin-netwerkfee bovenop de publisher-commissie, bv. 30 (optioneel, default 0)
//   AWIN_PROXY_KEY       sleutel voor deze endpoint (valt terug op SHOPSTATS_PROXY_KEY)
//
// Aanroep: /api/awin-costs?key=...&start=2026-09-01&end=2026-09-30[&format=csv|json][&override=30]
//          &mode=publishers  geeft totalen per publisher over de periode (kliks, transacties, commissie)
//          &mode=orders      geeft elke transactie met orderRef, publisher en vouchercode (om aan Eyk-orders te koppelen)

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

async function fetchPublisherChunk(adv, token, from, to) {
  const u = new URL(`${API}/advertisers/${adv}/reports/publisher`);
  u.searchParams.set("startDate", from);
  u.searchParams.set("endDate", to);
  u.searchParams.set("region", "NL");
  u.searchParams.set("timezone", TZ);
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw Object.assign(new Error("Awin rate limit bereikt, probeer het over een minuut opnieuw."), { status: 429 });
  if (!res.ok) throw Object.assign(new Error(`Awin API ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: 502 });
  return res.json();
}

async function publishers(req, res, { adv, token, start, end, override, format }) {
  const P = {};
  const n = (v) => Number(v) || 0;
  for (let from = start; from <= end; from = addDays(from, 31)) {
    const to = addDays(from, 30) < end ? addDays(from, 30) : end;
    const list = await fetchPublisherChunk(adv, token, from, to);
    for (const r of Array.isArray(list) ? list : []) {
      const id = String(r.publisherId ?? "");
      if (!id) continue;
      const p = (P[id] ||= { publisherId: id, name: "", clicks: 0, impressions: 0, transactions: 0, revenue: 0, commission: 0, pendingCommission: 0, declined: 0, declinedValue: 0 });
      p.name = r.publisherName || p.name;
      p.clicks += n(r.clicks); p.impressions += n(r.impressions);
      p.transactions += n(r.pendingNo) + n(r.confirmedNo);
      p.revenue += n(r.pendingValue) + n(r.confirmedValue);
      p.commission += n(r.pendingComm) + n(r.confirmedComm) + n(r.bonusComm);
      p.pendingCommission += n(r.pendingComm);
      p.declined += n(r.declinedNo); p.declinedValue += n(r.declinedValue);
    }
  }
  const rows = Object.values(P)
    .map((p) => ({ ...p, revenue: r2(p.revenue), commission: r2(p.commission), pendingCommission: r2(p.pendingCommission), declinedValue: r2(p.declinedValue), costs: r2(p.commission * (1 + override / 100)) }))
    .filter((p) => p.clicks || p.transactions || p.commission || p.declined)
    .sort((a, b) => b.costs - a.costs);
  res.setHeader("Cache-Control", "no-store");
  if (format === "json") return res.status(200).json({ start, end, overridePct: override, publishers: rows });
  const head = "Periode van;Periode tot;Publisher-ID;Publisher;Kliks;Vertoningen;Transacties;Omzet;Commissie;Waarvan pending;Override %;Kosten;Afgekeurd;Afgekeurde omzet";
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = rows.map((p) => [start, end, p.publisherId, esc(p.name), p.clicks, p.impressions, p.transactions, p.revenue, p.commission, p.pendingCommission, override, p.costs, p.declined, p.declinedValue].join(";"));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="awin-publishers-${start}_${end}.csv"`);
  return res.status(200).send([head, ...lines].join("\n"));
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

  if (q.mode === "orders") {
    try {
      const out = [];
      for (let from = start; from <= end; from = addDays(from, 31)) {
        const to = addDays(from, 30) < end ? addDays(from, 30) : end;
        for (const t of await fetchChunk(adv, token, from, to)) {
          const status = String(t.commissionStatus || "").toLowerCase();
          const comm = Number(t.commissionAmount?.amount) || 0;
          out.push({ date: String(t.transactionDate || "").slice(0, 10), orderRef: t.orderRef ?? "", publisherId: String(t.publisherId ?? ""),
            siteName: t.siteName || "", status, voucher: t.voucherCodeUsed ? (t.voucherCode || "ja") : "", clickDate: t.clickDate || "",
            revenue: r2(Number(t.saleAmount?.amount) || 0), commission: r2(comm), costs: COUNTED.has(status) ? r2(comm * (1 + override / 100)) : 0 });
        }
      }
      res.setHeader("Cache-Control", "no-store");
      if (q.format === "json") return res.status(200).json({ start, end, overridePct: override, transactions: out });
      const head = "Datum;Order-ref;Publisher-ID;Publisher;Status;Voucher;Klikdatum;Omzet;Commissie;Kosten";
      const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="awin-orders-${start}_${end}.csv"`);
      return res.status(200).send([head, ...out.map((t) => [t.date, esc(t.orderRef), t.publisherId, esc(t.siteName), t.status, esc(t.voucher), t.clickDate, t.revenue, t.commission, t.costs].join(";"))].join("\n"));
    } catch (e) { return res.status(e.status || 502).json({ error: e.message }); }
  }

  if (q.mode === "publishers") {
    try { return await publishers(req, res, { adv, token, start, end, override, format: q.format }); }
    catch (e) { return res.status(e.status || 502).json({ error: e.message }); }
  }

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
