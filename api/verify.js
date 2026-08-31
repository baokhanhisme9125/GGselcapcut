/**
 * /api/verify?orderid=XXX[&email=YYY]
 *
 * GGSEL CapCut delivery:
 * - If orderid + email → verify email match then deliver
 * - If orderid only   → auto-deliver (for GGSEL "By link" flow)
 *
 * Steps:
 * 1. Check Orders sheet (idempotency)
 * 2. Verify via GGSEL API (purchase/info/{invoice_id})
 * 3. Match buyer email (if provided)
 * 4. Detect product (7d / 1m) by item_id
 * 5. Deliver account from correct sheet
 * 6. Save to Orders sheet
 */
const { verifyOrder } = require('../lib/ggsel');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  savePendingOrder,
  findOrderByCode,
} = require('../lib/sheets');

/* ── Concurrency guard ────────────────────────────────────────────────── */
const _pending = new Map();
const PENDING_TTL = 30_000;

/* ── Global delivery mutex ── */
let _deliveryLock = Promise.resolve();
function acquireDeliveryLock() {
  let release;
  const prev = _deliveryLock;
  _deliveryLock = new Promise(r => { release = r; });
  return prev.then(() => release);
}

function cleanPending() {
  const now = Date.now();
  for (const [k, t] of _pending) {
    if (now - t > PENDING_TTL) _pending.delete(k);
  }
}

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
    /* ── 1. Verify via GGSEL API first to resolve uniqueCode ── */
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

    /* ── 2. Concurrency guard ────────────────────────────────────── */
    cleanPending();
    if (_pending.has(orderKey)) {
      await new Promise(r => setTimeout(r, 3000));
      const existing = await findOrderByCode(orderKey);
      if (existing) {
        if (existing.isPending) {
          return res.status(503).json({
            success: false, outOfStock: true, isPending: true,
            productName: existing.productName,
            ggselUUID: uniqueCode,
            error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
          });
        }
        return alreadyDeliveredResponse(res, existing, uniqueCode);
      }
      return res.status(429).json({
        success: false,
        error: 'Order is being processed. Please wait and refresh.',
      });
    }
    _pending.set(orderKey, Date.now());

    /* ── 3. Idempotency check ────────────────────────────────────── */
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      if (emailParam && emailParam !== (existing.buyerEmail || '').toLowerCase()) {
        return res.status(403).json({ success: false, error: 'Email does not match. / Email не совпадает.' });
      }
      // If pending (C blank) — seller hasn't filled account yet
      if (existing.isPending) {
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: existing.productName,
          ggselUUID: uniqueCode,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }
      return alreadyDeliveredResponse(res, existing, uniqueCode);
    }

    /* ── 4. Email match (only if email was provided) ─────────────── */
    if (emailParam && orderInfo.buyerEmail && orderInfo.buyerEmail !== emailParam) {
      return res.status(403).json({
        success: false,
        error: 'Email does not match purchase email. / Email не совпадает.',
      });
    }

    /* ── 5. Detect product & get account from stock ────────────────── */
    const PRODUCTS = {
      '5450773': { sheetName: 'CapCut Pro 7 Ngày',  productType: '7d', productName: 'CapCut Pro 7 Days (GGSEL)' },
      '5065211': { sheetName: 'CapCut Pro 1 Tháng', productType: '1m', productName: 'CapCut Pro 1 Month (GGSEL)' },
    };

    console.log(`[ggsel] Order ${orderId} → productId: "${orderInfo.productId}"`);

    // Detect by product ID, default to 1m
    let product = PRODUCTS[orderInfo.productId];
    if (!product) {
      product = PRODUCTS['5065211']; // default 1m
    }

    const { sheetName, productType, productName } = product;

    /* ── ATOMIC: lock → get account → delete → save → release ── */
    const releaseLock = await acquireDeliveryLock();
    let account;
    try {
      // Re-check idempotency inside lock
      const raceCheck = await findOrderByCode(orderKey);
      if (raceCheck && !raceCheck.isPending) { releaseLock(); return alreadyDeliveredResponse(res, raceCheck, uniqueCode); }
      if (raceCheck && raceCheck.isPending) {
        releaseLock();
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true, productName: raceCheck.productName,
          ggselUUID: uniqueCode,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically.',
        });
      }

      account = await getNextAvailableAccount(sheetName);
      if (!account) {
        await savePendingOrder({
          uniqueCode: orderKey, buyerEmail: orderInfo.buyerEmail,
          orderId, productType, productName, ggselUUID: uniqueCode,
        });
        releaseLock();
        console.log(`[ggsel] OOS — saved pending order for ${orderId}`);
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true, productName,
          ggselUUID: uniqueCode,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }

      await deleteAccountRow(sheetName, account.rowIndex);
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
      releaseLock();

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
    } catch (lockErr) { releaseLock(); throw lockErr; }

  } catch (err) {
    console.error('[ggsel-verify] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Try again.' });
  } finally {
    _pending.delete(orderKey);
  }
};
