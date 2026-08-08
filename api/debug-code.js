/**
 * /api/debug-code?code=XXX
 * TEMPORARY — test GGSEL API endpoints for unique code lookup
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

    // Try purchase list endpoints
    const endpoints = [
      { name: 'GET_purchase_list', url: `${GGSEL_API}/purchase/list`, method: 'GET' },
      { name: 'GET_purchases', url: `${GGSEL_API}/purchases`, method: 'GET' },
      { name: 'GET_orders', url: `${GGSEL_API}/orders`, method: 'GET' },
      { name: 'GET_seller_purchases', url: `${GGSEL_API}/seller/purchases`, method: 'GET' },
      { name: 'POST_purchase_list', url: `${GGSEL_API}/purchase/list`, method: 'POST', body: { unique_code: code } },
      { name: 'POST_purchase_search', url: `${GGSEL_API}/purchase/search`, method: 'POST', body: { unique_code: code } },
      { name: 'GET_purchase_list_item5450773', url: `${GGSEL_API}/purchase/list/5450773`, method: 'GET' },
      { name: 'GET_purchase_list_item5065211', url: `${GGSEL_API}/purchase/list/5065211`, method: 'GET' },
    ];

    for (const ep of endpoints) {
      try {
        const opts = {
          method: ep.method,
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        };
        if (ep.body) opts.body = JSON.stringify(ep.body);
        const r = await fetch(ep.url, opts);
        const text = await r.text();
        try {
          const json = JSON.parse(text);
          // If it's a list, only show first 2 items + total count
          if (json.content && Array.isArray(json.content)) {
            results[ep.name] = { retval: json.retval, total: json.content.length, first2: json.content.slice(0, 2) };
          } else {
            results[ep.name] = json;
          }
        } catch {
          results[ep.name] = { status: r.status, text: text.substring(0, 200) };
        }
      } catch (e) { results[ep.name] = { error: e.message }; }
    }

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
