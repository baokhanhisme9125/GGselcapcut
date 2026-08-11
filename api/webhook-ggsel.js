/**
 * /api/webhook-ggsel
 * GGSEL sends GET request with:
 *   id_i={order_id}, id_d={product_id}, amount, email1, sha256, etc.
 * 
 * We use id_i to call GGSEL API → get purchase.name (=uniqueCode UUID)
 * Then store mapping: uniqueCode → orderId in CodeMap tab (auto-created)
 */
const { verifyOrder } = require('../lib/ggsel');
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

function getAuth() {
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT JSON'); }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function ensureCodeMapSheet(sheets) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === 'CodeMap');
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: 'CodeMap' } } }] },
      });
      console.log('[webhook-ggsel] Created CodeMap tab');
    }
  } catch (e) {
    console.log('[webhook-ggsel] ensureCodeMapSheet error:', e.message);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GGSEL sends GET params
  const query = req.query || {};
  const body  = req.body  || {};

  console.log('[webhook-ggsel] query:', JSON.stringify(query));
  console.log('[webhook-ggsel] body:', JSON.stringify(body));

  // id_i = order/invoice ID from GGSEL notification
  const orderId = String(
    query.id_i || query.content_id || query.invoice_id ||
    body.id_i  || body.content_id  || body.invoice_id || ''
  ).trim();

  if (!orderId || !/^\d+$/.test(orderId)) {
    console.log('[webhook-ggsel] No valid orderId found in:', { query, body });
    return res.status(200).json({ ok: true, note: 'no orderId' });
  }

  try {
    // Call GGSEL API to get purchase details → purchase.name = uniqueCode UUID
    const orderInfo = await verifyOrder(orderId);
    const uniqueCode = (orderInfo.raw && orderInfo.raw.name) ? String(orderInfo.raw.name).trim() : '';

    console.log(`[webhook-ggsel] orderId=${orderId}, uniqueCode=${uniqueCode}, productId=${orderInfo.productId}`);

    if (uniqueCode) {
      const auth = await getAuth();
      const sheets = google.sheets({ version: 'v4', auth });
      await ensureCodeMapSheet(sheets);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'CodeMap!A:D',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            uniqueCode,
            orderId,
            orderInfo.productId || '',
            new Date().toISOString(),
          ]],
        },
      });
      console.log(`[webhook-ggsel] ✅ Mapped ${uniqueCode} → ${orderId}`);
    }
  } catch (e) {
    console.error('[webhook-ggsel] Error:', e.message);
  }

  return res.status(200).json({ ok: true });
};
