/**
 * /api/debug-code?code=XXX
 * Test Digiseller API for unique code verification
 */
const { getToken } = require('../lib/ggsel');
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing code param' });

  try {
    const token = await getToken();
    const results = {};

    // Digiseller API: verify purchase by unique code
    try {
      const r = await fetch(`https://api.digiseller.com/api/purchases/unique-code/${code}?token=${token}`, {
        headers: { 'Accept': 'application/json' },
      });
      results['digiseller_unique_code'] = await r.json();
    } catch (e) { results['digiseller_unique_code'] = { error: e.message }; }

    // Also try oplata.info (reserve URL)
    try {
      const r2 = await fetch(`https://oplata.info/api/purchases/unique-code/${code}?token=${token}`, {
        headers: { 'Accept': 'application/json' },
      });
      results['oplata_unique_code'] = await r2.json();
    } catch (e) { results['oplata_unique_code'] = { error: e.message }; }

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
