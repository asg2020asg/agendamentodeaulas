const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { MercadoPagoConfig, Preference, Payment, WebhookSignatureValidator } = require('mercadopago');

const app = express();
const port = process.env.PORT || 3000;
const accessToken = process.env.MP_ACCESS_TOKEN;
const publicKey = process.env.MP_PUBLIC_KEY;
const webhookSecret = process.env.MP_WEBHOOK_SECRET || '';
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const allowedOrigin = process.env.FRONTEND_URL || '*';

const bookingsById = new Map();
const paymentStatusById = new Map();

if (!accessToken) {
  console.warn('⚠️  MP_ACCESS_TOKEN ausente. Defina no arquivo .env antes de subir o servidor.');
}

const client = new MercadoPagoConfig({ accessToken: accessToken || 'dummy-token' });
const preference = new Preference(client);
const payment = new Payment(client);

app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buffer) => {
    if (req.originalUrl === '/api/webhook') {
      req.rawBody = Buffer.from(buffer);
    }
  }
}));
app.use(express.static(path.join(__dirname)));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

function getBaseUrl(req) {
  const origin = publicBaseUrl || req.headers.origin || `http://localhost:${port}`;
  return origin.replace(/\/$/, '');
}

function getFrontendUrl(req) {
  const origin = process.env.FRONTEND_URL || req.headers.origin || getBaseUrl(req);
  return origin.replace(/\/$/, '');
}

function createBookingId() {
  return crypto.randomUUID();
}

function getBookingState(bookingId) {
  const booking = bookingsById.get(bookingId);
  if (!booking) {
    return { status: 'not_found' };
  }

  const paymentStatus = paymentStatusById.get(bookingId) || booking.status || 'pending';
  return {
    bookingId,
    status: paymentStatus,
    amount: booking.amount,
    service: booking.service,
    customerName: booking.name,
    customerPhone: booking.phone,
    date: booking.date,
    time: booking.time,
    createdAt: booking.createdAt
  };
}

function setPaymentStatus(bookingId, status, extra = {}) {
  if (!bookingId) return;
  const current = bookingsById.get(bookingId) || {};
  const next = { ...current, ...extra, status };
  bookingsById.set(bookingId, next);
  paymentStatusById.set(bookingId, status);
}

app.get('/api/config', (req, res) => {
  res.json({
    publicKey: publicKey || '',
    configured: Boolean(accessToken),
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox'
  });
});

app.post('/api/create-payment', async (req, res) => {
  try {
    if (!accessToken) {
      return res.status(500).json({ error: 'Mercado Pago não configurado. Defina MP_ACCESS_TOKEN no .env.' });
    }

    const payload = req.body || {};
    const bookingId = createBookingId();
    const finalAmount = Number(payload.amount || 0);
    const title = payload.title || payload.service || 'Agendamento de aula';

    if (!payload.name || !payload.phone || !payload.date || !payload.time || !title || !Number.isFinite(finalAmount) || finalAmount <= 0) {
      return res.status(400).json({ error: 'Dados do agendamento incompletos.' });
    }

    const bookingData = {
      bookingId,
      name: String(payload.name).trim(),
      phone: String(payload.phone).trim(),
      service: String(title).trim(),
      category: String(payload.category || 'B'),
      description: String(payload.description || 'Agendamento de aula').trim(),
      date: String(payload.date),
      time: String(payload.time),
      amount: Number(finalAmount),
      obs: String(payload.obs || '').trim(),
      createdAt: new Date().toISOString(),
      status: 'pending'
    };

    bookingsById.set(bookingId, bookingData);

    const createdPreference = await preference.create({
      body: {
        items: [{
          title: String(title),
          quantity: 1,
          unit_price: Number(finalAmount),
          currency_id: 'BRL',
          description: bookingData.description || 'Agendamento de aula'
        }],
        payer: {
          email: String(payload.email || 'cliente@exemplo.com')
        },
        external_reference: bookingId,
        metadata: {
          bookingId,
          customerName: bookingData.name,
          customerPhone: bookingData.phone,
          serviceName: bookingData.service,
          bookingDate: bookingData.date,
          bookingTime: bookingData.time
        },
        back_urls: {
          success: `${getFrontendUrl(req)}/pagamento-sucesso.html?bookingId=${bookingId}`,
          failure: `${getFrontendUrl(req)}/pagamento-falha.html?bookingId=${bookingId}`,
          pending: `${getFrontendUrl(req)}/pagamento-pendente.html?bookingId=${bookingId}`
        },
        auto_return: 'approved',
        notification_url: `${getBaseUrl(req)}/api/webhook`
      }
    });

    setPaymentStatus(bookingId, 'pending', {
      preferenceId: createdPreference.id,
      initPoint: createdPreference.init_point,
      sandboxInitPoint: createdPreference.sandbox_init_point || createdPreference.init_point
    });

    return res.json({
      bookingId,
      preferenceId: createdPreference.id,
      initPoint: createdPreference.init_point,
      sandboxInitPoint: createdPreference.sandbox_init_point || createdPreference.init_point,
      status: 'pending'
    });
  } catch (error) {
    console.error('Erro ao criar preferência:', error);
    return res.status(500).json({
      error: 'Não foi possível criar a preferência de pagamento.',
      details: error.message
    });
  }
});

app.get('/api/booking-status', (req, res) => {
  const bookingId = req.query.bookingId;
  if (!bookingId) {
    return res.status(400).json({ error: 'bookingId obrigatório.' });
  }

  return res.json(getBookingState(bookingId));
});

app.post('/api/webhook', async (req, res) => {
  try {
    const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const signature = req.headers['x-signature'];
    const requestId = req.headers['x-request-id'];
    const dataId = req.headers['x-data-id'];

    if (!webhookSecret) {
      console.warn('⚠️  MP_WEBHOOK_SECRET não configurado. Webhook sem validação.');
    }

    if (webhookSecret) {
      const payload = JSON.parse(rawBody.toString('utf8') || '{}');
      try {
        WebhookSignatureValidator.validate({
          xSignature: signature,
          xRequestId: requestId,
          dataId: dataId || payload?.data?.id,
          secret: webhookSecret,
          toleranceSeconds: 300
        });
      } catch (error) {
        console.error('Assinatura do webhook inválida:', error.message);
        return res.status(401).json({ error: 'Assinatura inválida do webhook.' });
      }
    }

    const payload = JSON.parse(rawBody.toString('utf8') || '{}');
    const type = payload.type;
    const paymentId = payload?.data?.id;
    let paymentDetails = null;
    if (type === 'payment' && paymentId && accessToken) {
      paymentDetails = await payment.get({ id: String(paymentId) });
    }

    const bookingId = paymentDetails?.external_reference;

    if (type === 'payment' && paymentId) {
      console.log(`Webhook recebido: type=${type}, paymentId=${paymentId}, status=${paymentDetails?.status || 'unknown'}`);
    }

    if (bookingId) {
      const nextStatus = paymentDetails?.status || 'pending';
      setPaymentStatus(bookingId, nextStatus, { paymentId, updatedAt: new Date().toISOString() });
    }

    return res.status(200).json({ received: true, type, paymentId, bookingId });
  } catch (error) {
    console.error('Erro no webhook:', error);
    return res.status(400).json({ error: 'Webhook inválido.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'mercado-pago-node' });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
  console.log('Use: npm start');
});
