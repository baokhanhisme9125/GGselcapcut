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
   PRODUCT SHEETS  — Column A: Email:Password (also accepts Email;Password)
───────────────────────────────────────────────────────────── */

function parseAccountCell(cell) {
  if (!cell || cell.startsWith('CLAIMED:') || cell.startsWith('FORMAT_ERROR:')) return null;
  const atIdx = cell.indexOf('@');
  let sepIdx = -1, sep = null;
  if (atIdx >= 0) {
    const c = cell.indexOf(':', atIdx + 1), s = cell.indexOf(';', atIdx + 1);
    if (c >= 0 && (s < 0 || c <= s)) { sepIdx = c; sep = ':'; } else if (s >= 0) { sepIdx = s; sep = ';'; }
  } else {
    const c = cell.indexOf(':'), s = cell.indexOf(';');
    if (c >= 0 && (s < 0 || c <= s)) { sepIdx = c; sep = ':'; } else if (s >= 0) { sepIdx = s; sep = ';'; }
  }
  if (sepIdx < 0 || !sep) return null;
  const email = cell.slice(0, sepIdx).trim(), password = cell.slice(sepIdx + 1).trim();
  if (!email || !password || !email.includes('@')) return null;
  return { email, password };
}


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
  if (!uniqueCode) throw new Error('[sheets] uniqueCode is required for claiming');
  const sheets = await getSheetsClient();

  const [stockRes, deliveredSet] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A:B`,
    }),
    getDeliveredAccountSet(sheets),
  ]);

  const rows = stockRes.data.values || [];

  const alreadyClaimed = rows.some(r => (r[0] || '').trim() === `CLAIMED:${uniqueCode}`);
  if (alreadyClaimed) {
    console.log(`[sheets] CLAIMED:${uniqueCode} already exists — waiting...`);
    await new Promise(r => setTimeout(r, 800));
    return null;
  }

  // Auto-cleanup stale CLAIMED rows (timestamp-based, older than 5 min)
  const STALE_MS = 5 * 60 * 1000;
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell.startsWith('CLAIMED:')) continue;
    const backup = (rows[i][1] || '').trim();
    const claimTs = parseInt(cell.split(':')[1], 10);
    if (!isNaN(claimTs) && claimTs > 1700000000000 && Date.now() - claimTs > STALE_MS && backup) {
      console.warn(`[sheets] Reverting stale CLAIMED row ${i + 1}`);
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${sheetName}'!A${i + 1}:B${i + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[backup, '']] },
        });
      } catch (e) { console.warn('[sheets] Stale revert failed:', e.message); }
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell) continue;
    if (cell.startsWith('CLAIMED:')) continue;
    if (cell.startsWith('FORMAT_ERROR:')) continue;
    const parsed = parseAccountCell(cell);
    if (!parsed) {
      if (cell.includes(':') || cell.includes(';') || cell.includes('@')) {
        console.warn(`[sheets] FORMAT_ERROR row ${i + 1}: "${cell.slice(0, 60)}"`);
        try {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${sheetName}'!A${i + 1}`,
            valueInputOption: 'RAW',
            requestBody: { values: [[`FORMAT_ERROR: ${cell}`]] },
          });
        } catch (e) { console.warn('[sheets] Could not write FORMAT_ERROR:', e.message); }
      }
      continue;
    }
    const { email, password } = parsed;

    const normalized = `${email}:${password}`.toLowerCase();
    if (deliveredSet.has(normalized)) {
      console.warn(`[sheets] Skipping already-delivered account at row ${i + 1}: ${email}`);
      continue;
    }

    // Backup to Column B, then claim Column A
    const claimMark = `CLAIMED:${uniqueCode}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A${i + 1}:B${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[claimMark, cell]] },
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
async function deleteAccountRow(sheetName, rowIndex, claimMark) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const sheetId = sheet.properties.sheetId;

  if (claimMark) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${sheetName}'!A:A` });
    const allRows = res.data.values || [];
    const indices = allRows.reduce((acc, r, i) => { if ((r[0] || '').trim() === claimMark) acc.push(i); return acc; }, []);
    if (indices.length > 1) console.warn(`[sheets] Deleting ${indices.length} duplicate markers: ${claimMark}`);
    for (let j = indices.length - 1; j >= 0; j--) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: indices[j], endIndex: indices[j] + 1 } } }] },
        });
      } catch (e) { console.warn(`deleteAccountRow failed index ${indices[j]}:`, e.message); }
    }
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }] },
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

async function findAllOrdersByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Orders!A:G',
  });
  const rows = res.data.values || [];
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      const accountCell = rows[i][2] || '';
      const colonIdx    = accountCell.indexOf(':');
      matches.push({
        rowIndex:        i + 1,
        uniqueCode:      rows[i][0] || '',
        buyerEmail:      rows[i][1] || '',
        accountEmail:    colonIdx >= 0 ? accountCell.slice(0, colonIdx).trim() : accountCell,
        accountPassword: colonIdx >= 0 ? accountCell.slice(colonIdx + 1).trim() : '',
        soldAt:          rows[i][3] || '',
        orderId:         rows[i][4] || '',
        productType:     rows[i][5] || '',
        productName:     rows[i][6] || 'CapCut Pro',
        isPending:       !accountCell.includes(':'),
      });
    }
  }
  return matches;
}

async function deleteOrderRow(rowIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === ORDERS_SHEET);
  if (!sheet) throw new Error('Orders sheet not found');
  const sheetId = sheet.properties.sheetId;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }],
    },
  });
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
      return c.includes(':');
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
  findAllOrdersByCode,
  deleteOrderRow,
  findRecentOrderByEmail,
  getAllStock,
  PRODUCT_SHEETS,
};
