/**
 * /api/debug-code?code=XXX
 * TEMPORARY — test GGSEL API endpoints for unique code verification
 * DELETE after debugging!
 */
const { getToken } = require('../lib/ggsel');
const fetch = require('node-fetch');

const GGSEL_API = 'https://seller.ggsel.com/api_sellers/api';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing code param' });

  try {
    const token = await getToken();
    const results = {};

    // Try 1: POST /goods/check with unique_code
    try {
      const r1 = await fetch(`${GGSEL_API}/goods/check`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ unique_code: code }),
      });
      results['POST_goods_check'] = await r1.json();
    } catch (e) { results['POST_goods_check'] = { error: e.message }; }

    // Try 2: GET /purchase/info/{unique_code}
    try {
      const r2 = await fetch(`${GGSEL_API}/purchase/info/${code}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      });
      results['GET_purchase_info'] = await r2.json();
    } catch (e) { results['GET_purchase_info'] = { error: e.message }; }

    // Try 3: GET /goods/check/{unique_code}
    try {
      const r3 = await fetch(`${GGSEL_API}/goods/check/${code}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      });
      results['GET_goods_check_path'] = await r3.json();
    } catch (e) { results['GET_goods_check_path'] = { error: e.message }; }

    // Try 4: POST /goods/check with "code" key
    try {
      const r4 = await fetch(`${GGSEL_API}/goods/check`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ code: code }),
      });
      results['POST_goods_check_code_key'] = await r4.json();
    } catch (e) { results['POST_goods_check_code_key'] = { error: e.message }; }

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
