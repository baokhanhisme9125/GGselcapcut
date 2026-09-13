/**
 * /api/verify?orderid=XXX[&email=YYY]
 *
 * GGSEL CapCut delivery:
 * - If orderid + email → verify email match then deliver
 * - If orderid only   → auto-deliver (for GGSEL "By link" flow)
 *
 * Steps:
 * 1. Verify via GGSEL API
 * 2. Check Orders sheet (idempotency)
 * 3. Match buyer email (if provided)
 * 4. Detect product (7d / 1m) by item_id
 * 5. Claim account atomically (CLAIMED: marker)
 * 6. Double-check Orders before saving (cross-instance race guard)
 * 7. Post-save duplicate detection & cleanup
 */
const { verifyOrder } = require('../lib/ggsel');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  savePendingOrder,
  findOrderByCode,
  findAllOrdersByCode,
  deleteOrderRow,
} = require('../lib/sheets');

function alreadyDeliveredResponse(res, order, ggselUUID) {
  return res.status(200).json({
    success: true,
    alreadyDelivered: true,
    account: { email: order.accountEmail, password: order.accountPassword },
    order: {
      orderId:     order.orderId,
      buyerEmail:  order.buyerEmail,
      soldAt:      order.soldAt,
      productType: order.productType,
      productName: order.productName,
      ggselUUID:   ggselUUID || '',
    },
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const orderId    = (req.query.orderid || '').trim();
  const emailParam = (req.query.email   || '').trim().toLowerCase();
  const ggselUUID  = (req.query.ggsel_uuid || '').trim();

  if (!orderId) {
    return res.status(400).json({ success: false, error: 'Missing Order ID.' });
  }

  try {
    /* ── 1. Verify via GGSEL API ─────────────────────────────────── */
    let orderInfo;
    try {
      orderInfo = await verifyOrder(orderId);
    } catch (err) {
      return res.status(404).json({ success: false, error: err.message });
    }

    if (!orderInfo.isPaid) {
      return res.status(400).json({
        success: false,
        error: 'Order not paid. / Заказ не оплачен.',
      });
    }

    const uniqueCode = ggselUUID || orderInfo.uniqueCode || '';
    const orderKey = uniqueCode || `ggsel-${orderId}`;

    /* ── 1b. Block old orders (> 7 days) ─────────────────────────── */
    function parseDigiDate(str) {
      if (!str) return NaN;
      const d1 = new Date(str).getTime();
      if (!isNaN(d1)) return d1;
      const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
      if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
      const m2 = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (m2) return new Date(`${m2[3]}-${m2[2]}-${m2[1]}T00:00:00Z`).getTime();
      return NaN;
    }
    const MAX_ORDER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const orderDateMs = parseDigiDate(orderInfo.datePay);
    const CUTOFF_DATE_GGSEL = new Date('2026-07-27T00:00:00Z').getTime();
    if (!isNaN(orderDateMs) && orderDateMs < CUTOFF_DATE_GGSEL) {
      return res.status(400).json({ success: false, error: 'This order has expired. Delivery is no longer available. / Срок заказа истёк.' });
    }

    /* ── 2. Idempotency check ────────────────────────────────────── */
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      if (emailParam && emailParam !== (existing.buyerEmail || '').toLowerCase()) {
        return res.status(403).json({ success: false, error: 'Email does not match. / Email не совпадает.' });
      }
      if (existing.isPending) {
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: existing.productName, ggselUUID: uniqueCode,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }
      return alreadyDeliveredResponse(res, existing, uniqueCode);
    }

    /* ── 3. Email match ──────────────────────────────────────────── */
    if (emailParam && orderInfo.buyerEmail && orderInfo.buyerEmail !== emailParam) {
      return res.status(403).json({
        success: false,
        error: 'Email does not match purchase email. / Email не совпадает.',
      });
    }

    /* ── 4. Detect product ───────────────────────────────────────── */
    const PRODUCTS = {
      '5450773': { sheetName: 'CapCut Pro 7 Ngày',  productType: '7d', productName: 'CapCut Pro 7 Days (GGSEL)' },
      '5065211': { sheetName: 'CapCut Pro 1 Tháng', productType: '1m', productName: 'CapCut Pro 1 Month (GGSEL)' },
    };

    console.log(`[ggsel] Order ${orderId} → productId: "${orderInfo.productId}"`);

    let product = PRODUCTS[orderInfo.productId];
    if (!product) {
      product = PRODUCTS['5065211']; // default 1m
    }

    const { sheetName, productType, productName } = product;

    /* ── 5. Claim account atomically via CLAIMED: marker ─────────── */
    const account = await getNextAvailableAccount(sheetName, orderKey);
    if (!account) {
      // Check if pending already saved by another instance
      const pendingCheck = await findOrderByCode(orderKey);
      if (pendingCheck) {
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: pendingCheck.productName, ggselUUID: uniqueCode,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically.',
        });
      }
      await savePendingOrder({
        uniqueCode: orderKey, buyerEmail: orderInfo.buyerEmail,
        orderId, productType, productName, ggselUUID: uniqueCode,
      });
      console.log(`[ggsel] OOS — saved pending order for ${orderId}`);
      return res.status(503).json({
        success: false, outOfStock: true, isPending: true, productName,
        ggselUUID: uniqueCode,
        error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
      });
    }

    /* ── 6. Double-check Orders BEFORE saving (cross-instance race) ── */
    const raceCheck = await findOrderByCode(orderKey);
    if (raceCheck && !raceCheck.isPending) {
      console.warn(`[ggsel] Race detected for orderKey=${orderKey} — releasing claimed account`);
      try {
        await revertClaimedRow(sheetName, account.rowIndex, account.email, account.password);
      } catch (e) { console.warn('[ggsel] Could not revert claimed row:', e.message); }
      return alreadyDeliveredResponse(res, raceCheck, uniqueCode);
    }

    /* ── 7. Delete claimed row + save order ──────────────────────── */
    const claimMark = `CLAIMED:${orderKey}`;
    await deleteAccountRow(sheetName, account.rowIndex, claimMark);
    await saveOrder({
      uniqueCode:      orderKey,
      buyerEmail:      orderInfo.buyerEmail,
      accountEmail:    account.email,
      accountPassword: account.password,
      orderId:         orderId,
      productType,
      productName,
      ggselUUID:       uniqueCode,
    });

    /* ── 8. Post-save duplicate detection ────────────────────────── */
    try {
      const allOrders = await findAllOrdersByCode(orderKey);
      if (allOrders.length > 1) {
        console.warn(`[ggsel] DUPLICATE DETECTED: ${allOrders.length} orders for key=${orderKey}. Cleaning...`);
        for (let i = 1; i < allOrders.length; i++) {
          await deleteOrderRow(allOrders[i].rowIndex);
        }
      }
    } catch (e) { console.warn('[ggsel] Post-save duplicate check error:', e.message); }

    console.log(`[ggsel] Delivered ${productName} for order ${orderId}`);

    return res.status(200).json({
      success: true,
      alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: {
        orderId,
        buyerEmail:  orderInfo.buyerEmail,
        soldAt:      new Date().toISOString(),
        productType,
        productName,
        ggselUUID:   uniqueCode,
      },
    });

  } catch (err) {
    console.error('[ggsel-verify] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Try again.' });
  }
};

/* ── Helper: revert a CLAIMED row back to original account ── */
async function revertClaimedRow(sheetName, rowIndex, email, password) {
  const { google } = require('googleapis');
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'); }
  catch { return; }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `'${sheetName}'!A${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[`${email}:${password}`]] },
  });
}
