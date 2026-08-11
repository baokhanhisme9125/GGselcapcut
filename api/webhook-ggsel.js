/**
 * /api/webhook-ggsel
 * Receives GGSEL purchase notifications.
 * Stores unique_code → order_id mapping so buyers can auto-receive their account.
 * 
 * GGSEL Custom Notification should point to:
 * https://g-gselcapcut.vercel.app/api/webhook-ggsel
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

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Log EVERYTHING for debugging (first few calls)
  const body = req.body || {};
  const query = req.query || {};
  const allData = { method: req.method, query, body, headers: req.headers };

  console.log('[webhook-ggsel] Received:', JSON.stringify(allData));

  // Try to extract order info from various possible formats
  const orderId = body.content_id || body.invoice_id || body.id || query.content_id || query.id || '';
  const uniqueCode = body.unique_code || body.uniquecode || body.name || query.uniquecode || query.unique_code || '';

  // Store the raw webhook data to a "Webhooks" sheet for debugging
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Webhooks!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          new Date().toISOString(),
          String(orderId),
          String(uniqueCode),
          JSON.stringify(allData).substring(0, 5000),
        ]],
      },
    });
  } catch (e) {
    console.log('[webhook-ggsel] Sheet save error (create "Webhooks" tab?):', e.message);
  }

  // If we got both orderId and uniqueCode, store the mapping
  if (orderId && uniqueCode) {
    try {
      const sheets = await getSheetsClient();
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'CodeMap!A:C',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [[
            String(uniqueCode),
            String(orderId),
            new Date().toISOString(),
          ]],
        },
      });
      console.log(`[webhook-ggsel] Mapped ${uniqueCode} → ${orderId}`);
    } catch (e) {
      console.log('[webhook-ggsel] CodeMap save error (create "CodeMap" tab?):', e.message);
    }
  }

  return res.status(200).json({ ok: true });
};
