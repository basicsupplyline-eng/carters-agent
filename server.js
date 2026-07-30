// Carters Order Agent
// Receives WhatsApp/SMS requests, parses them with Claude, emails Carters,
// stores the order, and lets you (or Carters) confirm an ETA that gets texted back.

const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------- CONFIG (all from environment variables, set these in Render) ----------
const {
  ANTHROPIC_API_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,       // your Twilio WhatsApp or SMS number, e.g. whatsapp:+14155238886
  CARTERS_EMAIL,            // email address of your Carters contact
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  ADMIN_PASSWORD,           // simple password to protect the ETA-entry page
  PORT = 3000
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT) || 587,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// ---------- SIMPLE FILE-BASED ORDER STORE ----------
const DB_PATH = path.join(__dirname, 'orders.json');
function loadOrders() {
  if (!fs.existsSync(DB_PATH)) return {};
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveOrders(orders) {
  fs.writeFileSync(DB_PATH, JSON.stringify(orders, null, 2));
}

// ---------- STEP 1: Incoming message from customer via Twilio ----------
app.post('/webhook/incoming', async (req, res) => {
  const fromNumber = req.body.From;       // customer's number
  const messageBody = req.body.Body;      // raw text they sent

  try {
    // Ask Claude to extract structured order info
    const parseResp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `A customer sent this building supply order request via text:
"${messageBody}"

Extract the details and respond ONLY with JSON, no other text, in this exact format:
{
  "items": [{"name": "...", "quantity": "...", "unit": "..."}],
  "delivery_address": "...",
  "urgency": "...",
  "notes": "...",
  "unclear": true/false,
  "clarification_needed": "..."
}
If any field is missing from the message, use an empty string. Set "unclear" to true only if the request is too vague to action.`
      }]
    });

    const rawText = parseResp.content.find(c => c.type === 'text').text;
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const order = JSON.parse(cleaned);

    // If Claude flags it as too unclear to action, ask the customer to clarify instead of forwarding
    if (order.unclear) {
      await sendMessage(fromNumber, `Thanks for your message. Could you confirm: ${order.clarification_needed}`);
      return res.status(200).send('<Response></Response>');
    }

    // Save the order
    const orderId = randomUUID().slice(0, 8);
    const orders = loadOrders();
    orders[orderId] = {
      id: orderId,
      customerNumber: fromNumber,
      rawMessage: messageBody,
      parsed: order,
      status: 'sent_to_carters',
      createdAt: new Date().toISOString()
    };
    saveOrders(orders);

    // Email Carters with the formatted order
    const itemLines = order.items.map(i => `- ${i.quantity} ${i.unit} ${i.name}`).join('\n');
    await mailer.sendMail({
      from: SMTP_USER,
      to: CARTERS_EMAIL,
      subject: `New order request [${orderId}]`,
      text: `New order request from MRG Property.

Order ID: ${orderId}

Items:
${itemLines}

Delivery address: ${order.delivery_address || 'not specified - please confirm'}
Urgency: ${order.urgency || 'not specified'}
Notes: ${order.notes || 'none'}

Original message: "${messageBody}"

---
Please reply or call to confirm, then enter the ETA here:
${process.env.PUBLIC_URL || 'https://YOUR-RENDER-URL.onrender.com'}/admin/confirm/${orderId}
`
    });

    // Confirm receipt to the customer immediately
    await sendMessage(fromNumber, `Got your order request (ref ${orderId}). We've sent it to Carters and will text you the ETA shortly.`);

    res.status(200).send('<Response></Response>');
  } catch (err) {
    console.error('Error processing incoming order:', err);
    res.status(200).send('<Response></Response>'); // still 200 so Twilio doesn't retry endlessly
  }
});

// ---------- STEP 2: Simple admin page for Carters/you to enter the ETA ----------
app.get('/admin/confirm/:orderId', (req, res) => {
  const orders = loadOrders();
  const order = orders[req.params.orderId];
  if (!order) return res.status(404).send('Order not found');

  res.send(`
    <html><body style="font-family: sans-serif; max-width: 500px; margin: 40px auto;">
      <h2>Confirm order ${order.id}</h2>
      <p><b>Items:</b> ${order.parsed.items.map(i => `${i.quantity} ${i.unit} ${i.name}`).join(', ')}</p>
      <p><b>Delivery:</b> ${order.parsed.delivery_address}</p>
      <form method="POST" action="/admin/confirm/${order.id}">
        <label>Password: <input type="password" name="password" required></label><br><br>
        <label>ETA (e.g. "Thursday afternoon" or "2-3 days"): <input type="text" name="eta" required style="width:300px"></label><br><br>
        <button type="submit">Confirm order & text customer</button>
      </form>
    </body></html>
  `);
});

app.post('/admin/confirm/:orderId', async (req, res) => {
  const { password, eta } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(403).send('Wrong password');

  const orders = loadOrders();
  const order = orders[req.params.orderId];
  if (!order) return res.status(404).send('Order not found');

  order.status = 'confirmed';
  order.eta = eta;
  saveOrders(orders);

  await sendMessage(order.customerNumber, `Good news - your order (ref ${order.id}) is confirmed. ETA: ${eta}`);

  res.send(`<html><body style="font-family: sans-serif; max-width:500px; margin:40px auto;">
    <p>Confirmed. Customer has been texted the ETA.</p>
  </body></html>`);
});

// ---------- Helper: send via WhatsApp or SMS depending on how the customer reached you ----------
async function sendMessage(to, body) {
  await twilioClient.messages.create({
    from: TWILIO_FROM_NUMBER,
    to,
    body
  });
}

app.get('/', (req, res) => res.send('Carters order agent is running.'));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
