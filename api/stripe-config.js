const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';
const currency = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();
const depositAmount = Number.parseInt(process.env.STRIPE_DEPOSIT_AMOUNT, 10);
const normalizedDeposit = Number.isFinite(depositAmount) && depositAmount > 0 ? depositAmount : 0;

module.exports = (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  res.status(200).json({
    publishableKey: publishableKey || null,
    paymentRequired: Boolean(publishableKey && stripeSecretKey && normalizedDeposit > 0),
    currency,
    depositAmount: normalizedDeposit
  });
};
