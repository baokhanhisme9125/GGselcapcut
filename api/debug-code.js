/**
 * /api/debug-code?code=XXX
 * Try all possible GGSEL API endpoints for unique code lookup
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

    const endpoints = [
      // GGSEL seller API variations
      { name: 'purchase_unique_code', url: `https://seller.ggsel.com/api_sellers/api/purchase/unique-code/${code}?token=${token}` },
      { name: 'purchase_unique_code2', url: `https://seller.ggsel.com/api_sellers/api/purchase/unique_code/${code}?token=${token}` },
      { name: 'purchase_check', url: `https://seller.ggsel.com/api_sellers/api/purchase/check/${code}?token=${token}` },
      { name: 'purchase_bycode', url: `https://seller.ggsel.com/api_sellers/api/purchase/bycode/${code}?token=${token}` },
      { name: 'delivery_check', url: `https://seller.ggsel.com/api_sellers/api/delivery/check/${code}?token=${token}` },
      // Try without api_sellers prefix
      { name: 'api_purchase_uc', url: `https://seller.ggsel.com/api/purchases/unique-code/${code}?token=${token}` },
      { name: 'api_purchase_uc2', url: `https://seller.ggsel.com/api/purchase/unique-code/${code}?token=${token}` },
      // Try ggsel.com domain
      { name: 'ggsel_purchase_uc', url: `https://ggsel.com/api/purchases/unique-code/${code}?token=${token}` },
      { name: 'ggsel_net_uc', url: `https://ggsel.net/api/purchases/unique-code/${code}?token=${token}` },
      // POST attempts on GGSEL seller API
      { name: 'POST_purchase_check', url: `https://seller.ggsel.com/api_sellers/api/purchase/check`, method: 'POST', body: { unique_code: code } },
      { name: 'POST_delivery_check', url: `https://seller.ggsel.com/api_sellers/api/delivery/check`, method: 'POST', body: { unique_code: code } },
      // Try to get recent purchases list
      { name: 'GET_sales', url: `https://seller.ggsel.com/api_sellers/api/sales?token=${token}` },
      { name: 'GET_sales_list', url: `https://seller.ggsel.com/api_sellers/api/sales/list?token=${token}` },
      { name: 'POST_purchase_list', url: `https://seller.ggsel.com/api_sellers/api/purchase/list`, method: 'POST', body: { page: 1, count: 5 } },
      { name: 'POST_sales_report', url: `https://seller.ggsel.com/api_sellers/api/sales/report`, method: 'POST', body: { page: 1 } },
    ];

    for (const ep of endpoints) {
      try {
        const opts = {
          method: ep.method || 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
        };
        if (ep.body) opts.body = JSON.stringify(ep.body);
        const r = await fetch(ep.url, opts);
        const text = await r.text();
        try {
          const json = JSON.parse(text);
          // Truncate large arrays
          if (json.content && Array.isArray(json.content) && json.content.length > 2) {
            results[ep.name] = { retval: json.retval, total: json.content.length, first2: json.content.slice(0, 2) };
          } else {
            results[ep.name] = json;
          }
        } catch {
          results[ep.name] = { status: r.status, text: text.substring(0, 300) };
        }
      } catch (e) { results[ep.name] = { error: e.message }; }
    }

    return res.status(200).json(results);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
