/**
 * /api/webhook-ggsel
 * Receives GGSEL purchase notifications.
 * Stores unique_code → order_id mapping in existing spreadsheet.
 * Auto-creates "CodeMap" tab if it doesn't exist.
 */
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

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

async function ensureSheetExists(sheets, sheetName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === sheetName);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] },
    });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = req.body || {};
  const query = req.query || {};

  // Log everything for debugging
  console.log('[webhook-ggsel] body:', JSON.stringify(body));
  console.log('[webhook-ggsel] query:', JSON.stringify(query));

  // Extract order info from various possible GGSEL formats
  const orderId    = String(body.content_id || body.invoice_id || body.id || query.content_id || query.id || '').trim();
  const uniqueCode = String(body.unique_code || body.uniquecode || body.name || query.uniquecode || query.unique_code || '').trim();

  // If we have both, save the mapping
  if (orderId && uniqueCode) {
    try {
      const sheets = await getSheetsClient();
      await ensureSheetExists(sheets, 'CodeMap');
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'CodeMap!A:C',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[ uniqueCode, orderId, new Date().toISOString() ]],
        },
      });
      console.log(`[webhook-ggsel] Mapped uniqueCode=${uniqueCode} → orderId=${orderId}`);
    } catch (e) {
      console.error('[webhook-ggsel] Save error:', e.message);
    }
  } else {
    console.log(`[webhook-ggsel] Missing data: orderId="${orderId}", uniqueCode="${uniqueCode}"`);
    console.log('[webhook-ggsel] Full raw body:', JSON.stringify({ body, query }));
  }

  return res.status(200).json({ ok: true });
};
