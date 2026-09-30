// api/channable-stock.js
// Proxy voor de Channable voorraad-check feed, zodat Sidekick hem direct kan downloaden.
// Endpoint: https://vercel-sfs-rho.vercel.app/api/channable-stock

const FEED_URL = "https://files.channable.com/zimLtbXCGhk6mbBJ8mXOdQ==.csv";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const upstream = await fetch(FEED_URL, {
      headers: { "User-Agent": "vercel-sfs-proxy" },
      cache: "no-store",
    });

    if (!upstream.ok) {
      return res
        .status(502)
        .send(`Upstream error: ${upstream.status} ${upstream.statusText}`);
    }

    const csv = await upstream.text();

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'inline; filename="channable-stock.csv"'
    );
    // Voorraad moet vers zijn: geen CDN-cache
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "HEAD") return res.status(200).end();
    return res.status(200).send(csv);
  } catch (err) {
    console.error("channable-stock proxy error:", err);
    return res.status(500).send("Proxy error");
  }
}
