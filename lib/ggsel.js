/**
 * lib/ggsel.js — GGSEL Seller API client
 *
 * Auth: SHA256 signature → Bearer token (cached)
 * Flow: POST /apilogin → GET /purchase/info/{invoice_id}
 */
const crypto = require('crypto');
const fetch  = require('node-fetch');

const GGSEL_API = 'https://seller.ggsel.com/api_sellers/api';

let _cachedToken = null;
let _tokenExpiry  = 0;

async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 3600_000) return _cachedToken;

  const sellerId = parseInt(process.env.GGSEL_SELLER_ID || '0', 10);
  const apiKey   = process.env.GGSEL_API_KEY || '';

  if (!sellerId || !apiKey) {
    throw new Error('Missing GGSEL_SELLER_ID or GGSEL_API_KEY.');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = crypto.createHash('sha256').update(`${apiKey}${timestamp}`).digest('hex');

  const res = await fetch(`${GGSEL_API}/apilogin`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify({ seller_id: sellerId, timestamp, sign }),
  });
  const data = await res.json();

  if (data.retval !== 0 || !data.token) {
    throw new Error(`GGSEL login failed: ${data.desc || data.retdesc || JSON.stringify(data)}`);
  }

  _cachedToken = data.token;
  _tokenExpiry = data.valid_thru ? new Date(data.valid_thru).getTime() : Date.now() + 23 * 3600_000;
  return _cachedToken;
}

/**
 * Verify an order by invoice ID.
 * Returns { buyerEmail, datePay, isPaid }
 */
async function verifyOrder(invoiceId) {
  const token = await getToken();

  const res = await fetch(`${GGSEL_API}/purchase/info/${invoiceId}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
  });
  const data = await res.json();

  if (!data || data.retval !== 0 || !data.content) {
    const desc = data ? (data.retdesc || data.desc) : 'Unknown error';
    throw new Error(`Order not found: ${desc}`);
  }

  const purchase = data.content;
  const buyerEmail = (
    (purchase.buyer_info && purchase.buyer_info.email) ||
    purchase.email || ''
  ).trim().toLowerCase();

  return {
    buyerEmail,
    datePay: purchase.date_pay || purchase.pay_date || new Date().toISOString(),
    isPaid:  purchase.invoice_state === 3,
    productId: String(purchase.id_goods || purchase.product_id || ''),
    productName: purchase.product_name || purchase.name_goods || '',
    raw:     purchase,
  };
}

module.exports = { getToken, verifyOrder };
