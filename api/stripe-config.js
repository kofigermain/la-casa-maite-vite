const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
const currency = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();

const rawDeposit = process.env.STRIPE_DEPOSIT_AMOUNT;
const parsed = Number.parseInt(rawDeposit, 10);
const depositAmount = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(200).json({
    publishableKey: publishableKey || null,
    paymentRequired: Boolean(publishableKey && stripeSecretKey && depositAmount > 0),
    currency,
    depositAmount
  });
};
