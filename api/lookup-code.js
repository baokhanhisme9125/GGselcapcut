/**
 * /api/lookup-code?code=UUID
 * Look up order ID by GGSEL unique code from the CodeMap sheet.
 * Then auto-verify and deliver the account.
 */
const { verifyOrder } = require('../lib/ggsel');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
} = require('../lib/sheets');
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

async function findOrderIdByUniqueCode(uniqueCode) {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'CodeMap!A:B',
    });
    const rows = res.data.values || [];
    for (const row of rows) {
      if ((row[0] || '').trim() === uniqueCode.trim()) {
        return (row[1] || '').trim();
      }
    }
  } catch (e) {
    console.log('[lookup-code] CodeMap read error:', e.message);
  }
  return null;
}

const PRODUCTS = {
  '5450773': { sheetName: 'CapCut Pro 7 Ngày',  productType: '7d', productName: 'CapCut Pro 7 Days (GGSEL)' },
  '5065211': { sheetName: 'CapCut Pro 1 Tháng', productType: '1m', productName: 'CapCut Pro 1 Month (GGSEL)' },
};

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const uniqueCode = (req.query.code || '').trim();
  if (!uniqueCode) {
    return res.status(400).json({ success: false, error: 'Missing unique code.' });
  }

  try {
    // Step 1: Look up order ID from CodeMap
    const orderId = await findOrderIdByUniqueCode(uniqueCode);
    if (!orderId) {
      return res.status(404).json({
        success: false,
        needOrderId: true,
        error: 'Order not mapped yet. Please enter your Order Number manually.',
      });
    }

    // Step 2: Check if already delivered
    const orderKey = `ggsel-${orderId}`;
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      return res.status(200).json({
        success: true,
        alreadyDelivered: true,
        account: { email: existing.accountEmail, password: existing.accountPassword },
        order: {
          orderId: existing.orderId,
          buyerEmail: existing.buyerEmail,
          soldAt: existing.soldAt,
          productType: existing.productType,
          productName: existing.productName,
        },
      });
    }

    // Step 3: Verify via GGSEL API
    const orderInfo = await verifyOrder(orderId);
    if (!orderInfo.isPaid) {
      return res.status(400).json({ success: false, error: 'Order not paid.' });
    }

    // Step 4: Detect product and deliver
    let product = PRODUCTS[orderInfo.productId] || PRODUCTS['5065211'];
    const { sheetName, productType, productName } = product;

    const account = await getNextAvailableAccount(sheetName);
    if (!account) {
      return res.status(503).json({ success: false, outOfStock: true, productName, error: 'Out of stock.' });
    }

    // Step 5: Save and deliver
    await deleteAccountRow(sheetName, account.rowIndex);
    await saveOrder({
      uniqueCode: orderKey,
      buyerEmail: orderInfo.buyerEmail,
      accountEmail: account.email,
      accountPassword: account.password,
      orderId,
      productType,
      productName,
    });

    console.log(`[lookup-code] Auto-delivered ${productName} for order ${orderId} via uniqueCode ${uniqueCode}`);

    return res.status(200).json({
      success: true,
      alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: {
        orderId,
        buyerEmail: orderInfo.buyerEmail,
        soldAt: new Date().toISOString(),
        productType,
        productName,
      },
    });
  } catch (err) {
    console.error('[lookup-code] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Try again.' });
  }
};
