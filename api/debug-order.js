/**
 * /api/debug-order?orderid=XXX
 * TEMPORARY — shows raw GGSEL API response to find correct field names
 * DELETE THIS FILE after debugging!
 */
const { verifyOrder } = require('../lib/ggsel');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const orderId = (req.query.orderid || '').trim();
  if (!orderId) return res.status(400).json({ error: 'Missing orderid' });

  try {
    const info = await verifyOrder(orderId);
    return res.status(200).json({
      detectedProductId: info.productId,
      detectedProductName: info.productName,
      buyerEmail: info.buyerEmail,
      isPaid: info.isPaid,
      rawKeys: Object.keys(info.raw || {}),
      raw: info.raw,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
