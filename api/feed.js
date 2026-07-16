export default async function handler(req, res) {
  const FEED_URL = 'https://feed.dataedis.com/?feedid=73bca9b6-e3a0-4eec-aeca-6d53611aad36';

  try {
    const response = await fetch(FEED_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SuperfoodstoreBot/1.0)',
        'Accept': 'text/csv,text/plain,*/*',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Feed returned ${response.status}` });
    }

    const csv = await response.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Cache-Control', 's-maxage=3600'); // 1 uur cachen op Vercel edge
    res.status(200).send(csv);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
