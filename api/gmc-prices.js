// api/gmc-prices.js — Vercel-functie voor het vercel_sfs-project
//
// Haalt dagelijks twee rapporten uit de Google Merchant API en geeft ze als feed terug,
// zodat Sidekick ze net als de andere feeds kan downloaden:
//   - price_competitiveness_product_view: benchmarkprijs van Google per product
//   - price_insights_product_view: voorgestelde prijs + voorspelde verandering in vertoningen, kliks en conversies
//
// Aanroep:  /api/gmc-prices?key=GMC_PROXY_KEY            -> CSV (standaard)
//           /api/gmc-prices?key=GMC_PROXY_KEY&format=json -> JSON
//
// Omgevingsvariabelen in Vercel:
//   GMC_PROXY_KEY       zelfgekozen geheime sleutel voor deze feed
//   GMC_ACCOUNT_ID      Merchant Center-ID (het getal rechtsboven in Merchant Center)
//   GMC_SA_EMAIL        e-mailadres van het serviceaccount (…@….iam.gserviceaccount.com)
//   GMC_SA_KEY          private key van het serviceaccount (het veld "private_key" uit het JSON-sleutelbestand,
//                       inclusief -----BEGIN PRIVATE KEY----- en -----END PRIVATE KEY-----)
//   GMC_COUNTRY         optioneel, standaard NL

const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/content";
const API = "https://merchantapi.googleapis.com/reports/v1";

function b64url(buf){
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Accepteert de sleutel in elke vorm waarin hij in Vercel geplakt kan worden:
// het hele JSON-sleutelbestand, alleen "private_key", met of zonder aanhalingstekens, met letterlijke \n,
// of met spaties waar regeleinden horen.
function privateKey(){
  let k = String(process.env.GMC_SA_KEY || "").trim();
  if (!k) throw new Error("GMC_SA_KEY ontbreekt in Vercel");
  if (k.startsWith("{")){
    let j; try { j = JSON.parse(k); } catch { throw new Error("GMC_SA_KEY lijkt JSON maar is niet leesbaar; plak de hele inhoud van het sleutelbestand opnieuw, of alleen de waarde van private_key"); }
    if (!j.private_key) throw new Error(`GMC_SA_KEY is JSON maar zonder private_key (wel: ${Object.keys(j).join(", ")}). Gebruik het sleutelbestand dat Google downloadt bij Serviceaccount → Sleutels → Sleutel toevoegen → JSON.`);
    k = j.private_key;
  }
  k = k.replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  let m = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(k);
  if (!m){
    const bare = k.replace(/[^A-Za-z0-9+/=]/g, "");
    if (bare.length > 1000) m = [null, "PRIVATE KEY", bare];   // sleutel zonder BEGIN/END-regels
    else {
      // Niets van de sleutel zelf tonen, alleen een beschrijving om te zien wat er wél in staat
      const what = /^[0-9a-f]{40}$/i.test(k) ? "dit lijkt de private_key_id (40 tekens), niet de private_key"
        : /^\d{15,25}$/.test(k) ? "dit lijkt de client_id (alleen cijfers), niet de private_key"
        : /@.*gserviceaccount\.com$/i.test(k) ? "dit lijkt het e-mailadres van het serviceaccount, niet de private_key"
        : `de waarde is ${k.length} tekens lang; een private key is ongeveer 1.700 tekens`;
      throw new Error(`GMC_SA_KEY bevat geen geldige private key: ${what}. Plak in Vercel de hele inhoud van het JSON-sleutelbestand, of de waarde van "private_key" (begint met -----BEGIN PRIVATE KEY-----).`);
    }
  }
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, "");
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END ${m[1]}-----\n`;
}

async function accessToken(){
  const email = process.env.GMC_SA_EMAIL;
  const key = privateKey();
  if (!email) throw new Error("GMC_SA_EMAIL of GMC_SA_KEY ontbreekt");
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = b64url(crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(key));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Token ophalen mislukt: " + (j.error_description || j.error || r.status));
  return j.access_token;
}

async function search(token, account, query){
  const rows = [];
  let pageToken;
  do {
    const r = await fetch(`${API}/accounts/${account}/reports:search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, pageSize: 5000, ...(pageToken ? { pageToken } : {}) }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Merchant API ${r.status}: ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 300)}`);
    for (const row of j.results || []) rows.push(row);
    pageToken = j.nextPageToken;
  } while (pageToken);
  return rows;
}

// Merchant API geeft prijzen als { amountMicros: "12340000", currencyCode: "EUR" }
const money = p => (p && p.amountMicros != null ? Math.round(Number(p.amountMicros) / 10000) / 100 : null);
const num = v => (v == null || v === "" ? null : Number(v));

// Shopify (Google & YouTube-app) gebruikt offer_id "shopify_NL_<productId>_<variantId>"
function shopifyIds(offerId){
  const m = /^shopify_[A-Z]{2}_(\d+)_(\d+)$/i.exec(String(offerId || ""));
  return m ? { product_id: m[1], variant_id: m[2] } : { product_id: "", variant_id: "" };
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    if (!process.env.GMC_PROXY_KEY || q.key !== process.env.GMC_PROXY_KEY){ res.status(401).send("Ongeldige sleutel"); return; }
    const account = process.env.GMC_ACCOUNT_ID;
    if (!account){ res.status(500).send("GMC_ACCOUNT_ID ontbreekt"); return; }
    const country = String(q.country || process.env.GMC_COUNTRY || "NL").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);

    const token = await accessToken();
    const [comp, ins] = await Promise.all([
      search(token, account,
        `SELECT id, offer_id, price, benchmark_price, report_country_code FROM price_competitiveness_product_view WHERE report_country_code = '${country}'`),
      search(token, account,
        "SELECT id, offer_id, price, suggested_price, effectiveness, predicted_impressions_change_fraction, predicted_clicks_change_fraction, predicted_conversions_change_fraction FROM price_insights_product_view")
        .catch(e => { console.warn("price_insights niet beschikbaar:", e.message); return []; }),
    ]);

    const byOffer = new Map();
    const get = offer => {
      if (!byOffer.has(offer)) byOffer.set(offer, { offer_id: offer, ...shopifyIds(offer), price: null, benchmark_price: null, suggested_price: null,
        effectiveness: "", pred_impressions: null, pred_clicks: null, pred_conversions: null });
      return byOffer.get(offer);
    };
    for (const r of comp){
      const v = r.priceCompetitivenessProductView || {};
      if (!v.offerId) continue;
      const x = get(v.offerId);
      x.price = money(v.price); x.benchmark_price = money(v.benchmarkPrice);
    }
    for (const r of ins){
      const v = r.priceInsightsProductView || {};
      if (!v.offerId) continue;
      const x = get(v.offerId);
      if (x.price == null) x.price = money(v.price);
      x.suggested_price = money(v.suggestedPrice);
      x.effectiveness = v.effectiveness || "";
      x.pred_impressions = num(v.predictedImpressionsChangeFraction);
      x.pred_clicks = num(v.predictedClicksChangeFraction);
      x.pred_conversions = num(v.predictedConversionsChangeFraction);
    }

    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
    const rows = [...byOffer.values()].map(x => ({ date, country, ...x }));
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=600");

    if (q.format === "json"){ res.status(200).json({ date, country, count: rows.length, rows }); return; }

    const cols = ["date", "country", "offer_id", "product_id", "variant_id", "price", "benchmark_price", "suggested_price",
      "effectiveness", "pred_impressions", "pred_clicks", "pred_conversions"];
    const esc = v => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(",")].concat(rows.map(r => cols.map(c => esc(r[c])).join(","))).join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.status(200).send(csv);
  } catch (e){
    res.status(500).send("Fout: " + e.message);
  }
};
