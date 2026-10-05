// api/gmc-register.js — eenmalige registratie van het Google Cloud-project bij Merchant Center
//
// Gebruik (in de browser):
//   1. Status bekijken:  /api/gmc-register?key=GMC_PROXY_KEY
//   2. Registreren:      /api/gmc-register?key=GMC_PROXY_KEY&register=1&email=jouw@adres.nl
//      (email = technisch contactpersoon; een gewoon Google-account, geen serviceaccount)
//   3. Na ongeveer 5 minuten werkt /api/gmc-prices.
//
// Gebruikt dezelfde omgevingsvariabelen als gmc-prices.js:
//   GMC_PROXY_KEY, GMC_ACCOUNT_ID, GMC_SA_EMAIL, GMC_SA_KEY
// Voorwaarde: het serviceaccount staat in Merchant Center als gebruiker met BEHEERDERS-rechten (admin).
// Na een geslaagde registratie mag dit bestand weer uit het project.

const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/content";
const ACCOUNTS = "https://merchantapi.googleapis.com/accounts/v1";

function b64url(buf){
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Accepteert de sleutel in elke vorm waarin hij in Vercel geplakt kan worden:
// het hele JSON-sleutelbestand, alleen "private_key", met of zonder aanhalingstekens, met letterlijke \n,
// of met spaties waar regeleinden horen.
function privateKey(){
  let k = String(process.env.GMC_SA_KEY || "").trim();
  if (!k) throw new Error("GMC_SA_KEY ontbreekt in Vercel");
  if (k.startsWith("{")){ try { k = JSON.parse(k).private_key || ""; } catch { throw new Error("GMC_SA_KEY lijkt JSON maar is niet leesbaar; plak alleen de waarde van private_key"); } }
  k = k.replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").replace(/\r/g, "");
  const m = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----([\s\S]*?)-----END \1-----/.exec(k);
  if (!m) throw new Error("GMC_SA_KEY bevat geen geldige private key (verwacht -----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----)");
  const body = m[2].replace(/[^A-Za-z0-9+/=]/g, "");
  return `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END ${m[1]}-----\n`;
}

async function accessToken(){
  const email = process.env.GMC_SA_EMAIL;
  const key = privateKey();
  if (!email) throw new Error("GMC_SA_EMAIL of GMC_SA_KEY ontbreekt in Vercel");
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

async function call(token, method, url, body){
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let j; try { j = await r.json(); } catch { j = {}; }
  return { ok: r.ok, status: r.status, body: j };
}

function hint(status, msg){
  const m = String(msg || "");
  if (status === 403) return "Het serviceaccount heeft geen (beheerders)toegang in Merchant Center, of de Merchant API staat niet aan in het Google Cloud-project.";
  if (/ALREADY_REGISTERED/i.test(m)) return "Dit Google Cloud-project is al gekoppeld aan een (ander) Merchant Center-account.";
  if (/not registered/i.test(m)) return "Het project is nog niet geregistreerd: voeg &register=1&email=… toe aan de link.";
  if (/website/i.test(m)) return "Merchant Center heeft een geverifieerde website nodig voordat registratie kan.";
  return "";
}

module.exports = async (req, res) => {
  const out = (code, obj) => res.status(code).json(obj);
  try {
    const q = req.query || {};
    if (!process.env.GMC_PROXY_KEY || q.key !== process.env.GMC_PROXY_KEY){ out(401, { ok: false, error: "Ongeldige sleutel" }); return; }
    const account = process.env.GMC_ACCOUNT_ID;
    if (!account){ out(500, { ok: false, error: "GMC_ACCOUNT_ID ontbreekt in Vercel" }); return; }
    const token = await accessToken();
    const base = `${ACCOUNTS}/accounts/${account}/developerRegistration`;

    if (q.register === "1"){
      const email = String(q.email || "").trim();
      if (email && /gserviceaccount\.com$/i.test(email)){ out(400, { ok: false, error: "Gebruik een gewoon Google-account als contactpersoon, geen serviceaccount." }); return; }
      const r = await call(token, "POST", `${base}:registerGcp`, email ? { developerEmail: email } : {});
      const msg = r.body && r.body.error && r.body.error.message;
      out(r.ok ? 200 : r.status, {
        ok: r.ok,
        step: "registratie",
        result: r.body,
        next: r.ok
          ? (email ? `Geregistreerd. Accepteer de uitnodiging die naar ${email} is gestuurd (binnen 14 dagen) als dat adres nog geen Merchant Center-gebruiker is. Over ongeveer 5 minuten werkt /api/gmc-prices.`
                   : "Project gekoppeld. Zorg dat minstens één gebruiker in Merchant Center de rol API-ontwikkelaar heeft. Over ongeveer 5 minuten werkt /api/gmc-prices.")
          : (hint(r.status, msg) || msg || "Registratie mislukt"),
      });
      return;
    }

    const r = await call(token, "GET", base);
    const msg = r.body && r.body.error && r.body.error.message;
    out(r.ok ? 200 : r.status, {
      ok: r.ok,
      step: "status",
      registration: r.ok ? r.body : null,
      next: r.ok
        ? ((r.body.gcpIds || []).length ? "Dit Merchant Center-account heeft al een geregistreerd project; /api/gmc-prices zou moeten werken." : "Nog niet geregistreerd: voeg &register=1&email=jouw@adres.nl toe aan de link.")
        : (hint(r.status, msg) || msg || "Status ophalen mislukt"),
    });
  } catch (e){
    out(500, { ok: false, error: e.message });
  }
};
