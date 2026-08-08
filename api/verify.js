/**
 * /api/verify?orderid=XXX&email=YYY
 *
 * GGSEL CapCut 30-day delivery:
 * 1. Check Orders sheet (idempotency)
 * 2. Verify via GGSEL API (purchase/info/{invoice_id})
 * 3. Match buyer email
 * 4. Deliver account from "CapCut Pro 1 Tháng" sheet
 * 5. Save to Orders sheet
 */
const { verifyOrder } = require('../lib/ggsel');
const {
  getNextAvailableAccount,
  deleteAccountRow,
  saveOrder,
  findOrderByCode,
} = require('../lib/sheets');

/* ── Concurrency guard ──────────────────────────────────────────────── */
const _pending = new Map();
const PENDING_TTL = 30_000;

function cleanPending() {
  const now = Date.now();
  for (const [k, t] of _pending) {
    if (now - t > PENDING_TTL) _pending.delete(k);
  }
}

function alreadyDeliveredResponse(res, order) {
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
    },
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const orderId    = (req.query.orderid || '').trim();
  const emailParam = (req.query.email   || '').trim().toLowerCase();

  if (!orderId) {
    return res.status(400).json({ success: false, error: 'Missing Order ID.' });
  }
  if (!emailParam) {
    return res.status(400).json({ success: false, error: 'Missing email.' });
  }

  // Key for Orders sheet: prefix with "ggsel-" to avoid collision with Plati codes
  const orderKey = `ggsel-${orderId}`;

  try {
    /* ── 0. Concurrency guard ────────────────────────────────────── */
    cleanPending();
    if (_pending.has(orderKey)) {
      await new Promise(r => setTimeout(r, 3000));
      const existing = await findOrderByCode(orderKey);
      if (existing) return alreadyDeliveredResponse(res, existing);
      return res.status(429).json({
        success: false,
        error: 'Order is being processed. Please wait and refresh.',
      });
    }
    _pending.set(orderKey, Date.now());

    /* ── 1. Idempotency check ────────────────────────────────────── */
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      if (emailParam !== (existing.buyerEmail || '').toLowerCase()) {
        return res.status(403).json({
          success: false,
          error: 'Email does not match. / Email не совпадает.',
        });
      }
      return alreadyDeliveredResponse(res, existing);
    }

    /* ── 2. Verify via GGSEL API ─────────────────────────────────── */
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

    /* ── 3. Email match ──────────────────────────────────────────── */
    if (!orderInfo.buyerEmail || orderInfo.buyerEmail !== emailParam) {
      return res.status(403).json({
        success: false,
        error: 'Email does not match purchase email. / Email не совпадает.',
      });
    }

    /* ── 4. Detect product & get account from stock ────────────────── */
    const PRODUCTS = {
      '5450773': { sheetName: 'CapCut Pro 7 Ngày',  productType: '7d', productName: 'CapCut Pro 7 Days (GGSEL)' },
      '5065211': { sheetName: 'CapCut Pro 1 Tháng', productType: '1m', productName: 'CapCut Pro 1 Month (GGSEL)' },
    };

    // Detect by product ID first, then by name keywords, default to 1m
    let product = PRODUCTS[orderInfo.productId];
    if (!product) {
      const name = (orderInfo.productName || '').toLowerCase();
      if (/\b7\b|7.?day|7.?д/.test(name)) {
        product = PRODUCTS['5450773'];
      } else {
        product = PRODUCTS['5065211']; // default 1m
      }
    }

    const { sheetName, productType, productName } = product;

    const account = await getNextAvailableAccount(sheetName);
    if (!account) {
      return res.status(503).json({
        success: false,
        outOfStock: true,
        productName,
        error: 'Out of stock. Contact support. / Товар временно отсутствует.',
      });
    }

    /* ── 4.5. Race-condition guard ────────────────────────────────── */
    const raceCheck = await findOrderByCode(orderKey);
    if (raceCheck) {
      return alreadyDeliveredResponse(res, raceCheck);
    }

    /* ── 5. Deliver ──────────────────────────────────────────────── */
    await deleteAccountRow(sheetName, account.rowIndex);
    await saveOrder({
      uniqueCode:      orderKey,
      buyerEmail:      orderInfo.buyerEmail,
      accountEmail:    account.email,
      accountPassword: account.password,
      orderId:         orderId,
      productType,
      productName,
    });

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
      },
    });

  } catch (err) {
    console.error('[ggsel-verify] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error. Try again.' });
  } finally {
    _pending.delete(orderKey);
  }
};
