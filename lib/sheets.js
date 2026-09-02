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

/* ─────────────────────────────────────────────────────────────
   PRODUCT SHEETS  ("CapCut Pro 7 Ngày" / "CapCut Pro 1 Tháng" / "CapCut Pro 6 Tháng")
   Column A only:  Email:Password
   Example row:    acc1@email.com:Pass@123
───────────────────────────────────────────────────────────── */

/**
 * Build a Set of account strings (email:password) already present in Column C
 * of the Orders sheet, so we never re-deliver the same account.
 */
async function getDeliveredAccountSet(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'Orders'!C:C`,
    });
    const rows = res.data.values || [];
    const used = new Set();
    for (const row of rows) {
      const cell = (row[0] || '').trim().toLowerCase();
      if (cell && cell.includes(':')) used.add(cell);
    }
    return used;
  } catch {
    return new Set();
  }
}

/**
 * Atomically claim the next available account using optimistic locking
 * + duplicate-account guard.
 */
async function getNextAvailableAccount(sheetName, uniqueCode) {
  const sheets = await getSheetsClient();

  const [stockRes, deliveredSet] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A:A`,
    }),
    getDeliveredAccountSet(sheets),
  ]);

  const rows = stockRes.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell) continue;
    if (cell.startsWith('CLAIMED:')) continue;
    if (!cell.includes(':')) continue;

    const colonIdx = cell.indexOf(':');
    const email    = cell.slice(0, colonIdx).trim();
    const password = cell.slice(colonIdx + 1).trim();
    if (!email || !password) continue;

    // ── Duplicate guard ──
    const normalized = `${email}:${password}`.toLowerCase();
    if (deliveredSet.has(normalized)) {
      console.warn(`[sheets] Skipping already-delivered account at row ${i + 1}: ${email}`);
      continue;
    }

    // ── Optimistic lock: claim this row ──
    const claimMark = `CLAIMED:${uniqueCode || Date.now()}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[claimMark]] },
      });
    } catch (writeErr) {
      console.warn(`[sheets] Claim write failed row ${i + 1}:`, writeErr.message);
      continue;
    }

    await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));

    let verifyCell = '';
    try {
      const vRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A${i + 1}`,
      });
      verifyCell = (vRes.data.values?.[0]?.[0] || '').trim();
    } catch (readErr) {
      console.warn(`[sheets] Claim verify read failed row ${i + 1}:`, readErr.message);
      continue;
    }

    if (verifyCell === claimMark) {
      return { rowIndex: i + 1, email, password };
    }
    console.warn(`[sheets] Row ${i + 1} race lost (got: ${verifyCell.slice(0, 40)}), trying next`);
  }

  return null;
}

/**
 * Delete the delivered row from the product sheet.
 */
async function deleteAccountRow(sheetName, rowIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId:    sheet.properties.sheetId,
            dimension:  'ROWS',
            startIndex: rowIndex - 1,
            endIndex:   rowIndex,
          },
        },
      }],
    },
  });
}



/* ─────────────────────────────────────────────────────────────
   ORDERS SHEET  (tab: "Orders")
   A: UniqueCode | B: BuyerEmail | C: Account (Email:Password)
   D: SoldAt | E: PlatiOrderID | F: ProductType | G: ProductName
   H: DeliveryLink
───────────────────────────────────────────────────────────── */

async function saveOrder({ uniqueCode, buyerEmail, accountEmail, accountPassword, orderId, productType, productName, ggselUUID }) {
  const sheets = await getSheetsClient();
  const deliveryLink = ggselUUID
    ? `https://g-gselcapcut.vercel.app/delivery.html?uniquecode=${encodeURIComponent(ggselUUID)}`
    : `https://g-gselcapcut.vercel.app/delivery.html?orderid=${encodeURIComponent(orderId)}&email=${encodeURIComponent(buyerEmail)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        uniqueCode, buyerEmail,
        `${accountEmail}:${accountPassword}`,
        new Date().toISOString(), orderId, productType, productName, deliveryLink,
      ]],
    },
  });
}

async function savePendingOrder({ uniqueCode, buyerEmail, orderId, productType, productName, ggselUUID }) {
  const sheets = await getSheetsClient();
  const deliveryLink = ggselUUID
    ? `https://g-gselcapcut.vercel.app/delivery.html?uniquecode=${encodeURIComponent(ggselUUID)}`
    : `https://g-gselcapcut.vercel.app/delivery.html?orderid=${encodeURIComponent(orderId)}&email=${encodeURIComponent(buyerEmail)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        uniqueCode, buyerEmail,
        '',  // Column C blank — seller fills manually
        new Date().toISOString(), orderId, productType, productName, deliveryLink,
      ]],
    },
  });
}

async function findOrderByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:G',
  });

  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      const accountCell = rows[i][2] || '';
      const colonIdx    = accountCell.indexOf(':');
      const accountEmail    = colonIdx >= 0 ? accountCell.slice(0, colonIdx).trim() : accountCell;
      const accountPassword = colonIdx >= 0 ? accountCell.slice(colonIdx + 1).trim() : '';
      return {
        uniqueCode:      rows[i][0] || '',
        buyerEmail:      rows[i][1] || '',
        accountEmail,
        accountPassword,
        soldAt:          rows[i][3] || '',
        orderId:         rows[i][4] || '',
        productType:     rows[i][5] || '',
        productName:     rows[i][6] || 'CapCut Pro',
        isPending:       !accountCell.includes(':'),
      };
    }
  }
  return null;
}

async function findRecentOrderByEmail(buyerEmail, windowMs = 10 * 60 * 1000) {
  if (!buyerEmail || buyerEmail === 'unknown') return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:G',
  });
  const rows = res.data.values || [];
  const now = Date.now();
  const email = buyerEmail.trim().toLowerCase();
  let bestMatch = null;
  for (let i = 0; i < rows.length; i++) {
    const rowEmail = (rows[i][1] || '').trim().toLowerCase();
    if (rowEmail !== email) continue;
    const soldAt = rows[i][3] || '';
    const orderTime = new Date(soldAt).getTime();
    if (isNaN(orderTime) || now - orderTime > windowMs) continue;
    const accountCell = rows[i][2] || '';
    const colonIdx = accountCell.indexOf(':');
    bestMatch = {
      uniqueCode: rows[i][0]||'', buyerEmail: rows[i][1]||'',
      accountEmail: colonIdx>=0?accountCell.slice(0,colonIdx).trim():accountCell,
      accountPassword: colonIdx>=0?accountCell.slice(colonIdx+1).trim():'',
      soldAt, orderId: rows[i][4]||'', productType: rows[i][5]||'',
      productName: rows[i][6]||'CapCut Pro',
      isPending: !accountCell.includes(':'),
    };
  }
  return bestMatch;
}

/* ─────────────────────────────────────────────────────────────
   STOCK SUMMARY
───────────────────────────────────────────────────────────── */
const PRODUCT_SHEETS = [
  { key: '7d', name: 'CapCut Pro 7 Ngày',  sheetName: 'CapCut Pro 7 Ngày'  },
  { key: '1m', name: 'CapCut Pro 1 Tháng', sheetName: 'CapCut Pro 1 Tháng' },
  { key: '6m', name: 'CapCut Pro 6 Tháng', sheetName: 'CapCut Pro 6 Tháng' },
];

async function getSheetStock(sheetName) {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A:A`,
    });
    const rows = (res.data.values || []).filter(r => {
      const c = (r[0] || '').trim();
      return c.includes(':');    // valid Email:Password rows
    });
    return { available: rows.length, total: rows.length };
  } catch {
    return { available: 0, total: 0, error: 'Sheet not found' };
  }
}

async function getAllStock() {
  return Promise.all(
    PRODUCT_SHEETS.map(async p => ({
      key:  p.key,
      name: p.name,
      ...(await getSheetStock(p.sheetName)),
    }))
  );
}

module.exports = {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  savePendingOrder,
  findOrderByCode,
  findRecentOrderByEmail,
  getAllStock,
  PRODUCT_SHEETS,
};
