/*
 * Serverless function to handle booking enquiries.
 *
 * This function expects a POST request with a JSON body containing
 * { name: string, email: string, phone: string, checkIn: string,
 *   checkOut: string, guests: number|string, message: string } and
 * optionally payment data { amount: number, currency: string } when
 * Stripe is configured. It uses nodemailer to send the booking details
 * to a designated receiver email and, when STRIPE_SECRET_KEY is present,
 * creates a PaymentIntent so the client can complete the payment.
 * Configure the sender credentials, receiver address and Stripe secret via
 * environment variables as follows when deploying on Vercel:
 *
 *   EMAIL_USERNAME   – the SMTP username (e.g. Gmail address)
 *   EMAIL_PASSWORD   – the SMTP password or app password
 *   RECEIVER_EMAIL   – the address where enquiries should be delivered
 *   STRIPE_SECRET_KEY – the Stripe secret key used to create payments
 *
 * When running locally without dependencies installed, the send
 * operation will be skipped and the data will simply be logged.
 */

const nodemailer = require('nodemailer');

let stripeClient;

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    return null;
  }
  if (!stripeClient) {
    const Stripe = require('stripe');
    stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16'
    });
  }
  return stripeClient;
}

/**
 * Safely parse the request body regardless of whether Vercel has already
 * performed JSON parsing for us. When testing locally (e.g. with `vercel dev`)
 * the body can arrive either as an already-parsed object or as a raw stream.
 */
async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (req.body && typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (error) {
      throw new Error('Invalid JSON body');
    }
  }

  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
  }

  if (!raw) {
    throw new Error('Request body is empty');
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error('Invalid JSON body');
  }
}

module.exports = async (req, res) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).send('Method Not Allowed');
    return;
  }

  let data;
  try {
    data = await readJsonBody(req);
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }
  const {
    name,
    email,
    phone,
    checkIn,
    checkOut,
    guests,
    message,
    amount,
    currency
  } = data;
  // Validate required fields. All fields are mandatory for a complete booking enquiry.
  if (!name || !email || !phone || !checkIn || !checkOut || !guests || !message) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const stripe = getStripe();
  let paymentDetails = null;

  if (stripe) {
    const amountValue =
      typeof amount === 'string' && amount.trim() !== ''
        ? Number(amount)
        : amount;

    if (!Number.isFinite(amountValue)) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    const normalizedAmount = Math.round(amountValue);

    if (normalizedAmount <= 0 || Math.abs(normalizedAmount - amountValue) > 1e-6) {
      res.status(400).json({ error: 'Invalid payment amount' });
      return;
    }

    const normalizedCurrency =
      typeof currency === 'string' ? currency.trim().toLowerCase() : null;

    if (!normalizedCurrency || !/^[a-z]{3}$/.test(normalizedCurrency)) {
      res.status(400).json({ error: 'Invalid currency code' });
      return;
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: normalizedAmount,
        currency: normalizedCurrency,
        automatic_payment_methods: { enabled: true },
        receipt_email: email,
        description: `La Casa Maite booking for ${name}`,
        metadata: {
          name,
          email,
          phone,
          checkIn,
          checkOut,
          guests: String(guests)
        }
      });
      paymentDetails = {
        enabled: true,
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id
      };
    } catch (error) {
      console.error('Stripe payment intent creation failed:', error);
      res.status(502).json({ error: 'Failed to initiate payment' });
      return;
    }
  }
  // Attempt to send email via nodemailer if credentials are provided
  const user = process.env.EMAIL_USERNAME;
  const pass = process.env.EMAIL_PASSWORD;
  const receiver = process.env.RECEIVER_EMAIL || user;
  const responsePayment = paymentDetails || { enabled: false };
  if (user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass }
      });
      await transporter.sendMail({
        from: user,
        to: receiver,
        subject: 'New Booking Enquiry – La Casa Maite',
        text: `Name: ${name}\nEmail: ${email}\nPhone: ${phone}\nCheck‑in: ${checkIn}\nCheck‑out: ${checkOut}\nGuests: ${guests}\nMessage: ${message}`
      });
      res.status(200).json({
        status: 'sent',
        payment: responsePayment
      });
    } catch (error) {
      console.error('Email sending failed:', error);
      res.status(500).json({ error: 'Failed to send email' });
    }
  } else {
    // If no credentials are provided, just log the data and respond success
    console.log('Booking enquiry received:', {
      name,
      email,
      phone,
      checkIn,
      checkOut,
      guests,
      message,
      amount,
      currency
    });
    res.status(200).json({
      status: 'received',
      message: 'No email credentials configured',
      payment: responsePayment
    });
  }
};
