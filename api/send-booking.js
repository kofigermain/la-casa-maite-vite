const nodemailer = require('nodemailer');
const Stripe = require('stripe');

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey, { apiVersion: '2022-11-15' }) : null;

const currency = (process.env.STRIPE_CURRENCY || 'usd').toLowerCase();
const depositAmount = Number.parseInt(process.env.STRIPE_DEPOSIT_AMOUNT, 10);
const normalizedDeposit = Number.isFinite(depositAmount) && depositAmount > 0 ? depositAmount : 0;
const paymentRequired = Boolean(stripe && normalizedDeposit > 0);

const smtpPort = process.env.SMTP_PORT ? Number.parseInt(process.env.SMTP_PORT, 10) : 465;
const smtpSecure = process.env.SMTP_SECURE
  ? process.env.SMTP_SECURE === 'true'
  : smtpPort === 465;

const mailConfig = {
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpSecure,
  auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
};

const notifyTo = process.env.BOOKING_NOTIFICATION_TO;
const notifyFrom = process.env.BOOKING_NOTIFICATION_FROM || process.env.SMTP_USER;

const canSendMail = Boolean(
  mailConfig.host &&
  mailConfig.port &&
  mailConfig.auth &&
  notifyTo &&
  notifyFrom
);

const transporter = canSendMail ? nodemailer.createTransport(mailConfig) : null;

function formatCurrency(amount, currencyCode) {
  if (!amount) {
    return '0';
  }
  const value = amount / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: (currencyCode || 'usd').toUpperCase()
    }).format(value);
  } catch (err) {
    return `${value} ${currencyCode || ''}`.trim();
  }
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        const socket = req.socket || req.connection;
        if (socket && typeof socket.destroy === 'function') {
          socket.destroy();
        }
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function validateBooking(payload) {
  const requiredFields = ['name', 'email', 'phone', 'checkIn', 'checkOut', 'guests'];
  const missing = requiredFields.filter(field => !payload[field] || String(payload[field]).trim() === '');
  if (missing.length) {
    const error = new Error(`Missing required fields: ${missing.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
}

function formatBookingDetails(data) {
  return [
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Phone: ${data.phone}`,
    `Check-in: ${data.checkIn}`,
    `Check-out: ${data.checkOut}`,
    `Guests: ${data.guests}`,
    data.message ? `Message: ${data.message}` : null,
    data.paymentStatus ? `Payment status: ${data.paymentStatus}` : null,
    data.paymentIntentId ? `Payment intent: ${data.paymentIntentId}` : null
  ].filter(Boolean).join('\n');
}

async function sendNotificationEmail(data) {
  if (!transporter) {
    return;
  }
  const subjectBase = 'New booking enquiry';
  const subject = data.paymentStatus && data.paymentStatus.toLowerCase() === 'succeeded'
    ? `${subjectBase} (deposit received)`
    : subjectBase;

  const depositDisplay = normalizedDeposit
    ? formatCurrency(normalizedDeposit, currency)
    : 'No deposit charged';
  const textBody = `${formatBookingDetails(data)}\n\nDeposit amount: ${depositDisplay}`;
  const htmlLines = formatBookingDetails(data)
    .split('\n')
    .map(line => `<p>${line}</p>`)
    .join('');

  await transporter.sendMail({
    from: notifyFrom,
    to: notifyTo,
    subject,
    text: textBody,
    html: `<div>${htmlLines}<p><strong>Deposit amount:</strong> ${depositDisplay}</p></div>`
  });
}

async function createPaymentIntent(data) {
  if (!paymentRequired) {
    return null;
  }
  const intent = await stripe.paymentIntents.create({
    amount: normalizedDeposit,
    currency,
    metadata: {
      name: data.name,
      email: data.email,
      phone: data.phone,
      check_in: data.checkIn,
      check_out: data.checkOut,
      guests: String(data.guests),
      message: data.message || ''
    }
  });
  return intent;
}

async function handleConfirmAction(payload, res) {
  const responseData = { success: true };
  if (payload.paymentIntentId && stripe) {
    try {
      const intent = await stripe.paymentIntents.retrieve(payload.paymentIntentId);
      responseData.payment = {
        id: intent.id,
        status: intent.status
      };
      payload.paymentStatus = intent.status;
    } catch (err) {
      responseData.payment = { id: payload.paymentIntentId, status: 'unknown' };
    }
  }
  if (!payload.paymentStatus) {
    payload.paymentStatus = paymentRequired ? 'payment-pending' : 'not-charged';
  }
  try {
    await sendNotificationEmail(payload);
  } catch (mailErr) {
    responseData.mailError = 'Failed to send notification email';
  }
  res.status(200).json(responseData);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch (err) {
    res.status(400).json({ error: 'Invalid JSON body' });
    return;
  }

  if (payload.action === 'confirm') {
    await handleConfirmAction(payload, res);
    return;
  }

  try {
    validateBooking(payload);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
    return;
  }

  let paymentIntent = null;
  try {
    paymentIntent = await createPaymentIntent(payload);
  } catch (err) {
    console.error('Stripe payment intent error', err);
    res.status(500).json({ error: 'Unable to initiate payment' });
    return;
  }

  res.status(200).json({
    success: true,
    paymentRequired,
    payment: paymentIntent ? {
      clientSecret: paymentIntent.client_secret,
      id: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency
    } : null
  });
}