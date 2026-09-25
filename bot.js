require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const { Pool } = require("pg");

const BOT_TOKEN = process.env.BOT_TOKEN;
const SMM_API_URL = process.env.SMM_API_URL || "https://my.smmsun.com/api/v2";
const SMM_API_KEY = process.env.SMM_API_KEY;
const ADMIN_ID = String(process.env.ADMIN_ID || "").trim();
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT) || 10000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing.");
if (!SMM_API_KEY) console.warn("WARNING: SMM_API_KEY is missing.");
if (!ADMIN_ID) console.warn("WARNING: ADMIN_ID is missing.");
if (!DATABASE_URL) console.warn("WARNING: DATABASE_URL is missing. Persistent database is unavailable.");

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const webhookSecret = crypto.createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 40);
const webhookPath = `/telegram/webhook/${webhookSecret}`;

const DEFAULT_SERVICE_IDS = ["979", "133", "174", "3758", "1753", "622", "893", "2194", "1850", "1722", "9445"];

const defaultDb = () => ({
  serviceIds: [...DEFAULT_SERVICE_IDS],
  prices: {},
  paymentNumbers: [],
  users: {},
  orders: {},
  balances: {},
  deposits: {}
});

let db = defaultDb();
let pool = null;
if (DATABASE_URL) {
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
}

async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS bot_settings (id INTEGER PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const result = await pool.query("SELECT data FROM bot_settings WHERE id = 1");
  if (result.rows[0]?.data) db = { ...defaultDb(), ...result.rows[0].data };
  else await saveDb();
  normalizeDb();
}

function normalizeDb() {
  if (!Array.isArray(db.serviceIds)) db.serviceIds = [...DEFAULT_SERVICE_IDS];
  db.serviceIds = db.serviceIds.map(String);
  if (!db.prices || typeof db.prices !== "object") db.prices = {};
  if (!Array.isArray(db.paymentNumbers)) db.paymentNumbers = [];
  if (!db.users || typeof db.users !== "object") db.users = {};
  if (!db.orders || typeof db.orders !== "object") db.orders = {};
  if (!db.balances || typeof db.balances !== "object") db.balances = {};
  if (!db.deposits || typeof db.deposits !== "object") db.deposits = {};
}

let saveQueue = Promise.resolve();
function saveDb() {
  normalizeDb();
  if (!pool) return Promise.resolve();
  const snapshot = JSON.parse(JSON.stringify(db));
  saveQueue = saveQueue.then(async () => {
    await pool.query(`INSERT INTO bot_settings (id, data, updated_at) VALUES (1, $1::jsonb, NOW()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`, [JSON.stringify(snapshot)]);
  }).catch(err => console.error("Database save error:", err.message));
  return saveQueue;
}

function isAdmin(id) { return Boolean(ADMIN_ID) && String(id) === ADMIN_ID; }
function money(n) { return Number(n || 0).toFixed(2); }
function getBalance(uid) { return Number(db.balances[String(uid)] || 0); }
function setBalance(uid, amount) { db.balances[String(uid)] = Math.max(0, Number(amount || 0)); }

async function smm(params = {}) {
  if (!SMM_API_KEY) throw new Error("SMM_API_KEY is missing");
  const body = new URLSearchParams({ key: SMM_API_KEY, ...params });
  const r = await axios.post(SMM_API_URL, body.toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 20000 });
  return r.data;
}
async function getServices() {
  const data = await smm({ action: "services" });
  return Array.isArray(data) ? data : [];
}

function customerKeyboard(userId) {
  const rows = [
    [{ text: "📋 Services" }, { text: "💰 Balance" }],
    [{ text: "💳 Add Balance" }, { text: "🛒 New Order" }],
    [{ text: "📦 My Orders" }]
  ];
  if (isAdmin(userId)) rows.push([{ text: "⚙️ Admin Panel" }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}
function adminKeyboard() {
  return { keyboard: [
    [{ text: "📋 Manage Services" }],
    [{ text: "➕ Add Service ID" }, { text: "➖ Remove Service ID" }],
    [{ text: "💰 Set Price" }, { text: "⬆️ Increase Price" }],
    [{ text: "⬇️ Decrease Price" }, { text: "💳 Payment Numbers" }],
    [{ text: "✏️ Change Payment Number" }, { text: "💳 Payment Requests" }],
    [{ text: "👥 User Count" }],
    [{ text: "🔙 Customer Menu" }]
  ], resize_keyboard: true, is_persistent: true };
}

const states = new Map();
function setState(id, state) { states.set(String(id), state); }
function getState(id) { return states.get(String(id)); }
function clearState(id) { states.delete(String(id)); }

function rememberUser(msg) {
  const id = String(msg.from.id);
  db.users[id] = { id: msg.from.id, username: msg.from.username || "", firstName: msg.from.first_name || "", lastSeen: new Date().toISOString() };
  return saveDb();
}
function normalizeButton(text) {
  const raw = String(text || '').normalize('NFKC').replace(/[\uFE0E\uFE0F]/g, '').trim();
  const clean = raw.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
  const aliases = {
    'services': 'services',
    'balance': 'balance',
    'add balance': 'add balance',
    'new order': 'new order',
    'my orders': 'my orders',
    'admin panel': 'admin panel',
    'manage services': 'manage services',
    'add service id': 'add service id',
    'remove service id': 'remove service id',
    'set price': 'set price',
    'increase price': 'increase price',
    'decrease price': 'decrease price',
    'payment numbers': 'payment numbers',
    'change payment number': 'change payment number',
    'payment requests': 'payment requests',
    'user count': 'user count',
    'customer menu': 'customer menu'
  };
  return aliases[clean] || clean;
}

function selectedServiceInfo(all, serviceId) {
  const s = all.find(x => String(x.service ?? x.id ?? "") === String(serviceId));
  if (!s) return null;
  const providerRate = Number(s.rate || 0);
  const price = db.prices[String(serviceId)] !== undefined ? Number(db.prices[String(serviceId)]) : providerRate;
  return { ...s, id: String(serviceId), providerRate, price };
}

async function sendCustomerServices(chatId) {
  try {
    const all = await getServices();
    const selected = all.filter(s => db.serviceIds.includes(String(s.service ?? s.id ?? "")));
    if (!selected.length) return bot.sendMessage(chatId, "⚠️ আপনার নির্বাচিত কোনো service provider API-তে পাওয়া যায়নি।\n\nAdmin Panel → Manage Services থেকে ID পরীক্ষা করুন।");
    let text = "📋 Trusted BAZAAR Services\n\n";
    for (const s of selected) {
      const serviceId = String(s.service ?? s.id);
      const customPrice = db.prices[serviceId];
      const priceText = customPrice !== undefined ? `💰 Price/1K: ${money(customPrice)}` : `💰 Provider rate/1K: ${s.rate ?? "-"}`;
      const line = `🆔 ${serviceId}\n📌 ${s.name ?? "-"}\n${priceText}\n🔢 Min: ${s.min ?? "-"} | Max: ${s.max ?? "-"}\n\n`;
      if ((text + line).length > 3500) { await bot.sendMessage(chatId, text); text = "📋 Services (continued)\n\n"; }
      text += line;
    }
    return bot.sendMessage(chatId, text);
  } catch (e) {
    console.error("Services error:", e.response?.data || e.message);
    return bot.sendMessage(chatId, "❌ Services আনা যায়নি। SMM_API_KEY/API URL এবং Render Logs পরীক্ষা করুন।");
  }
}

async function manageServices(chatId) {
  const ids = db.serviceIds;
  const text = `📋 Selected Service IDs: ${ids.length}\n\n` + ids.map((id, i) => `${i + 1}. ID: ${id} | Price/1K: ${db.prices[id] ?? "Provider rate"}`).join("\n");
  return bot.sendMessage(chatId, text);
}

async function showPaymentNumbers(chatId) {
  const nums = db.paymentNumbers.length ? db.paymentNumbers.map((n, i) => `${i + 1}. ${n}`).join("\n") : "কোনো payment number যোগ করা হয়নি।";
  return bot.sendMessage(chatId, `💳 Payment Numbers\n\n${nums}`, { reply_markup: { inline_keyboard: [
    [{ text: "➕ Add Number", callback_data: "admin_pay_add" }, { text: "✏️ Change Number", callback_data: "admin_pay_change" }],
    [{ text: "🗑️ Remove Number", callback_data: "admin_pay_remove" }],
    [{ text: "🔙 Admin Panel", callback_data: "admin_panel" }]
  ] } });
}

async function showPaymentRequests(chatId) {
  const pending = Object.values(db.deposits).filter(d => d.status === "pending").sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!pending.length) return bot.sendMessage(chatId, "💳 Payment Requests\n\nকোনো pending payment নেই।", { reply_markup: adminKeyboard() });
  for (const d of pending.slice(0, 20)) {
    const text = `💳 Pending Payment\n\n🆔 ${d.id}\n👤 User: ${d.userId}\n💵 Amount: ${money(d.amount)}\n📱 Method/Number: ${d.paymentNumber}\n🔖 TxID: ${d.txId}\n🕒 ${d.createdAt}`;
    await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `dep_approve:${d.id}` }, { text: "❌ Reject", callback_data: `dep_reject:${d.id}` }]] } });
  }
}

async function handleAdminAction(id, uid, action) {
  if (action === "admin panel") { clearState(uid); return bot.sendMessage(id, "⚙️ Admin Panel", { reply_markup: adminKeyboard() }); }
  if (action === "manage services") return manageServices(id);
  if (action === "add service id") { setState(uid, { type: "add_service" }); return bot.sendMessage(id, "➕ Service ID যোগ করুন।\nএকটি বা একাধিক ID comma/space দিয়ে দিতে পারবেন।\nউদাহরণ: 979,133,2000"); }
  if (action === "remove service id") { setState(uid, { type: "remove_service" }); return bot.sendMessage(id, "➖ যে Service ID বাদ দিতে চান দিন।\nউদাহরণ: 979,133"); }
  if (action === "set price") { setState(uid, { type: "set_price" }); return bot.sendMessage(id, "💰 Price/1K সেট করুন।\nফরম্যাট: ServiceID Price\nউদাহরণ: 979 150"); }
  if (action === "increase price") { setState(uid, { type: "increase_price" }); return bot.sendMessage(id, "⬆️ কত টাকা/1K বাড়াবেন?\nফরম্যাট: ServiceID Amount\nউদাহরণ: 979 20"); }
  if (action === "decrease price") { setState(uid, { type: "decrease_price" }); return bot.sendMessage(id, "⬇️ কত টাকা/1K কমাবেন?\nফরম্যাট: ServiceID Amount\nউদাহরণ: 979 20"); }
  if (action === "payment numbers") return showPaymentNumbers(id);
  if (action === "change payment number") { setState(uid, { type: "payment_change" }); return bot.sendMessage(id, "✏️ নতুন payment number দিন。\nএটি বর্তমান payment number list replace করবে。"); }
  if (action === "payment requests") return showPaymentRequests(id);
  if (action === "user count") return bot.sendMessage(id, `👥 Registered users: ${Object.keys(db.users).length}`);
  if (action === "customer menu") { clearState(uid); return bot.sendMessage(id, "🏠 Customer Menu", { reply_markup: customerKeyboard(uid) }); }
}

async function startNewOrder(chatId, uid) {
  try {
    const all = await getServices();
    const selected = all.filter(s => db.serviceIds.includes(String(s.service ?? s.id ?? "")));
    if (!selected.length) return bot.sendMessage(chatId, "⚠️ কোনো service পাওয়া যায়নি। Admin আগে Service ID যোগ করুন।");
    const buttons = selected.slice(0, 60).map(s => {
      const sid = String(s.service ?? s.id);
      const p = db.prices[sid] !== undefined ? Number(db.prices[sid]) : Number(s.rate || 0);
      return [{ text: `${sid} • ${String(s.name || "Service").slice(0, 38)} • ৳${money(p)}/1K`, callback_data: `order_service:${sid}` }];
    });
    return bot.sendMessage(chatId, `🛒 New Order\n\n💰 আপনার Balance: ৳${money(getBalance(uid))}\n\nএকটি service নির্বাচন করুন:`, { reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error("New order services error:", e.response?.data || e.message);
    return bot.sendMessage(chatId, "❌ Service list আনা যায়নি।");
  }
}

async function showAddBalance(chatId) {
  if (!db.paymentNumbers.length) return bot.sendMessage(chatId, "⚠️ Admin এখনো কোনো payment number যোগ করেননি।");
  const nums = db.paymentNumbers.map((n, i) => `${i + 1}. ${n}`).join("\n");
  setState(chatId, { type: "deposit_amount" });
  return bot.sendMessage(chatId, `💳 Add Balance\n\nPayment করুন এই number-এ:\n${nums}\n\nএরপর কত টাকা পাঠিয়েছেন শুধু amount লিখুন।\nউদাহরণ: 100`);
}

async function submitDeposit(chatId, uid, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return bot.sendMessage(chatId, "⚠️ সঠিক amount দিন। উদাহরণ: 100");
  if (!db.paymentNumbers.length) return bot.sendMessage(chatId, "⚠️ Payment number সেট করা নেই।");
  setState(uid, { type: "deposit_txid", amount });
  return bot.sendMessage(chatId, `💵 Amount: ৳${money(amount)}\n\nএখন আপনার Transaction ID/TrxID পাঠান।\nউদাহরণ: TX123456789`);
}

bot.onText(/^\/start(?:\s+.*)?$/i, async msg => {
  await rememberUser(msg); clearState(msg.from.id);
  await bot.sendMessage(msg.chat.id, "👋 স্বাগতম!\n\n🤖 Trusted BAZAAR SMM Bot\n\nনিচের মেনু থেকে অপশন নির্বাচন করুন।", { reply_markup: customerKeyboard(msg.from.id) });
});
bot.onText(/^\/admin$/i, async msg => {
  await rememberUser(msg); if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ এই মেনু শুধু Admin-এর জন্য。");
  clearState(msg.from.id); return bot.sendMessage(msg.chat.id, "⚙️ Admin Panel", { reply_markup: adminKeyboard() });
});

bot.on("callback_query", async q => {
  try {
    const uid = q.from.id, chatId = q.message.chat.id, data = String(q.data || "");
    await bot.answerCallbackQuery(q.id);
    if (data.startsWith("order_service:")) {
      const sid = data.split(":")[1];
      const all = await getServices(); const s = selectedServiceInfo(all, sid);
      if (!s) return bot.sendMessage(chatId, "❌ Service পাওয়া যায়নি।");
      setState(uid, { type: "order_link", serviceId: sid, service: s });
      return bot.sendMessage(chatId, `📌 ${s.name}\n💰 Price: ৳${money(s.price)}/1K\n🔢 Min: ${s.min || "-"} | Max: ${s.max || "-"}\n\n🔗 এখন আপনার Link/Username পাঠান:`);
    }
    if (data === "admin_panel") {
      if (!isAdmin(uid)) return;
      clearState(uid);
      return bot.sendMessage(chatId, "⚙️ Admin Panel", { reply_markup: adminKeyboard() });
    }
    if (data === "admin_pay_add") {
      if (!isAdmin(uid)) return;
      setState(uid, { type: "payment_add" });
      return bot.sendMessage(chatId, "➕ নতুন payment number লিখুন।");
    }
    if (data === "admin_pay_change") {
      if (!isAdmin(uid)) return;
      setState(uid, { type: "payment_change" });
      return bot.sendMessage(chatId, "✏️ নতুন payment number দিন। এটি বর্তমান payment number replace করবে।");
    }
    if (data === "admin_pay_remove") {
      if (!isAdmin(uid)) return;
      if (!db.paymentNumbers.length) return bot.sendMessage(chatId, "⚠️ কোনো payment number নেই।");
      setState(uid, { type: "payment_remove" });
      return bot.sendMessage(chatId, `🗑️ যে payment number মুছবেন সেটি হুবহু পাঠান:\n\n${db.paymentNumbers.join("\n")}`);
    }
    if (data.startsWith("dep_approve:") || data.startsWith("dep_reject:")) {
      if (!isAdmin(uid)) return;
      const [action, depId] = data.split(":"); const d = db.deposits[depId];
      if (!d || d.status !== "pending") return bot.sendMessage(chatId, "⚠️ এই payment request আর pending নেই।");
      if (action === "dep_approve") {
        d.status = "approved"; d.approvedAt = new Date().toISOString(); d.approvedBy = uid;
        setBalance(d.userId, getBalance(d.userId) + Number(d.amount));
        await saveDb();
        await bot.sendMessage(d.userId, `✅ আপনার payment approved হয়েছে।\n💵 Added: ৳${money(d.amount)}\n💰 New Balance: ৳${money(getBalance(d.userId))}`, { reply_markup: customerKeyboard(d.userId) });
        return bot.sendMessage(chatId, `✅ Payment ${depId} approved.\nUser: ${d.userId}\nAmount: ৳${money(d.amount)}`, { reply_markup: adminKeyboard() });
      }
      d.status = "rejected"; d.rejectedAt = new Date().toISOString(); d.rejectedBy = uid;
      await saveDb();
      await bot.sendMessage(d.userId, `❌ আপনার payment request rejected হয়েছে।\n🆔 ${depId}`);
      return bot.sendMessage(chatId, `❌ Payment ${depId} rejected.`, { reply_markup: adminKeyboard() });
    }
  } catch (e) { console.error("Callback error:", e.stack || e.message); }
});

bot.on('message', async msg => {
  const chatId = msg?.chat?.id;
  const uid = msg?.from?.id;
  try {
    if (!chatId || !uid || msg.chat.type !== 'private') return;
    if (!msg.text || msg.text.startsWith('/')) return;

    const text = String(msg.text).trim();
    console.log(`[MESSAGE] uid=${uid} text=${JSON.stringify(text)}`);
    await rememberUser(msg);

    // Always allow menu buttons to cancel an unfinished input state.
    const action = normalizeButton(text);

    if (isAdmin(uid)) {
      const adminActions = new Set([
        'admin panel','manage services','add service id','remove service id','set price',
        'increase price','decrease price','payment numbers','change payment number',
        'payment requests','user count','customer menu'
      ]);
      if (adminActions.has(action)) {
        console.log(`[ADMIN ACTION] uid=${uid} action=${action}`);
        const result = await handleAdminAction(chatId, uid, action);
        if (result !== undefined) return;
      }
    }

    if (action === 'services') {
      clearState(uid);
      return await sendCustomerServices(chatId);
    }
    if (action === 'balance') {
      clearState(uid);
      return await bot.sendMessage(chatId, `💰 Your Balance\n\n৳${money(getBalance(uid))}`, { reply_markup: customerKeyboard(uid) });
    }
    if (action === 'add balance') {
      clearState(uid);
      return await showAddBalance(chatId);
    }
    if (action === 'new order') {
      clearState(uid);
      return await startNewOrder(chatId, uid);
    }
    if (action === 'my orders') {
      clearState(uid);
      const orders = Object.values(db.orders).filter(o => String(o.userId) === String(uid));
      if (!orders.length) return await bot.sendMessage(chatId, '📦 My Orders\n\nআপনার কোনো order পাওয়া যায়নি।', { reply_markup: customerKeyboard(uid) });
      const lines = orders.slice(-20).reverse().map(o => `🆔 ${o.id}\n📌 Service: ${o.serviceId}\n🔗 ${o.link}\n🔢 Qty: ${o.quantity}\n💵 Cost: ৳${money(o.cost)}\n📊 Status: ${o.status || 'Pending'}${o.providerOrderId ? `\n🔢 Provider Order: ${o.providerOrderId}` : ''}`);
      return await bot.sendMessage(chatId, `📦 My Orders\n\n${lines.join('\n\n')}`, { reply_markup: customerKeyboard(uid) });
    }

    const state = getState(uid);
    console.log(`[STATE] uid=${uid} state=${JSON.stringify(state || null)}`);

    if (state?.type === 'deposit_amount') {
      return await submitDeposit(chatId, uid, Number(text.replace(/,/g, '')));
    }
    if (state?.type === 'deposit_txid') {
      const txId = text.trim();
      if (txId.length < 3 || txId.length > 100) return await bot.sendMessage(chatId, '⚠️ সঠিক Transaction ID দিন।');
      const depId = `DEP-${Date.now()}-${String(uid).slice(-5)}`;
      db.deposits[depId] = { id: depId, userId: uid, amount: Number(state.amount), paymentNumber: db.paymentNumbers[0], txId, status: 'pending', createdAt: new Date().toISOString() };
      await saveDb(); clearState(uid);
      await bot.sendMessage(chatId, `✅ Payment request পাঠানো হয়েছে।\n🆔 ${depId}\n💵 Amount: ৳${money(state.amount)}\n🔖 TxID: ${txId}\n\nAdmin approve করলে balance যোগ হবে।`, { reply_markup: customerKeyboard(uid) });
      if (ADMIN_ID) await bot.sendMessage(ADMIN_ID, `🔔 নতুন payment request এসেছে।\n🆔 ${depId}\n👤 User: ${uid}\n💵 Amount: ৳${money(state.amount)}\n🔖 TxID: ${txId}`, { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `dep_approve:${depId}` }, { text: '❌ Reject', callback_data: `dep_reject:${depId}` }]] } });
      return;
    }

    if (state?.type === 'order_link') {
      if (!text) return await bot.sendMessage(chatId, '⚠️ Link দিন।');
      setState(uid, { ...state, type: 'order_quantity', link: text });
      return await bot.sendMessage(chatId, `🔢 Quantity লিখুন।\nMin: ${state.service.min || '-'}\nMax: ${state.service.max || '-'}\n\nউদাহরণ: 1000`);
    }
    if (state?.type === 'order_quantity') {
      const quantity = Number(text.replace(/,/g, ''));
      const min = Number(state.service.min || 0), max = Number(state.service.max || Number.MAX_SAFE_INTEGER);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity < min || quantity > max) return await bot.sendMessage(chatId, `⚠️ Quantity সঠিক নয়। Min ${min}, Max ${max}।`);
      const cost = Number(state.service.price) * quantity / 1000;
      if (getBalance(uid) < cost) {
        clearState(uid);
        return await bot.sendMessage(chatId, `❌ আপনার Balance কম।\nপ্রয়োজন: ৳${money(cost)}\nবর্তমান: ৳${money(getBalance(uid))}\n\nআগে 💳 Add Balance করুন।`, { reply_markup: customerKeyboard(uid) });
      }
      const orderId = `ORD-${Date.now()}-${String(uid).slice(-5)}`;
      try {
        const result = await smm({ action: 'add', service: state.serviceId, link: state.link, quantity: String(quantity) });
        if (result?.error) throw new Error(String(result.error));
        const providerOrderId = result?.order ? String(result.order) : '';
        setBalance(uid, getBalance(uid) - cost);
        db.orders[orderId] = { id: orderId, userId: uid, serviceId: state.serviceId, link: state.link, quantity, cost, status: 'Submitted', providerOrderId, createdAt: new Date().toISOString() };
        await saveDb(); clearState(uid);

        // Notify admin immediately after the provider accepts the order.
        if (ADMIN_ID) {
          const adminText = `🔔 NEW ORDER RECEIVED\n\n🆔 Order: ${orderId}\n👤 User ID: ${uid}\n${db.users[String(uid)]?.username ? `📛 Username: @${db.users[String(uid)].username}\n` : ''}📌 Service ID: ${state.serviceId}\n🔗 Link: ${state.link}\n🔢 Quantity: ${quantity}\n💵 Customer Cost: ৳${money(cost)}\n💰 User Balance: ৳${money(getBalance(uid))}\n📊 Status: Submitted${providerOrderId ? `\n🔢 Provider Order: ${providerOrderId}` : ''}\n🌐 API: ${SMM_API_URL}`;
          try { await bot.sendMessage(ADMIN_ID, adminText, { reply_markup: { inline_keyboard: [[{ text: '📋 Admin Panel', callback_data: 'admin_panel' }]] } }); }
          catch (notifyErr) { console.error('Admin order notification failed:', notifyErr.response?.body || notifyErr.message); }
        }

        return await bot.sendMessage(chatId, `✅ Order submitted successfully!\n\n🆔 ${orderId}\n📌 Service: ${state.serviceId}\n🔢 Quantity: ${quantity}\n💵 Cost: ৳${money(cost)}\n💰 Balance: ৳${money(getBalance(uid))}${providerOrderId ? `\n🔢 Provider Order: ${providerOrderId}` : ''}`, { reply_markup: customerKeyboard(uid) });
      } catch (e) {
        console.error('Provider order error:', e.response?.data || e.message);
        if (ADMIN_ID) {
          try { await bot.sendMessage(ADMIN_ID, `⚠️ ORDER FAILED\n\n👤 User ID: ${uid}\n📌 Service ID: ${state.serviceId}\n🔗 Link: ${state.link}\n🔢 Quantity: ${quantity}\n💵 Intended Cost: ৳${money(cost)}\n❌ Error: ${e.response?.data?.error || e.message}`); }
          catch (notifyErr) { console.error('Admin failed-order notification failed:', notifyErr.response?.body || notifyErr.message); }
        }
        return await bot.sendMessage(chatId, `❌ Provider order করা যায়নি।\n\n${e.response?.data?.error || e.message}\n\nআপনার Balance কাটা হয়নি।`);
      }
    }

    if (isAdmin(uid)) {
      if (state?.type === 'add_service') {
        const ids = text.split(/[,\s]+/).map(x => x.trim()).filter(Boolean), added = [];
        for (const serviceId of ids) if (/^\d+$/.test(serviceId) && !db.serviceIds.includes(serviceId)) { db.serviceIds.push(serviceId); added.push(serviceId); }
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, added.length ? `✅ Service ID যোগ হয়েছে:\n${added.join(', ')}` : '⚠️ নতুন কোনো ID যোগ হয়নি।', { reply_markup: adminKeyboard() });
      }
      if (state?.type === 'remove_service') {
        const ids = text.split(/[,\s]+/).map(x => x.trim()).filter(Boolean), before = db.serviceIds.length;
        db.serviceIds = db.serviceIds.filter(x => !ids.includes(x)); ids.forEach(x => delete db.prices[x]);
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, `✅ ${before - db.serviceIds.length}টি Service ID বাদ দেওয়া হয়েছে।`, { reply_markup: adminKeyboard() });
      }
      if (state?.type === 'set_price' || state?.type === 'increase_price' || state?.type === 'decrease_price') {
        const m = text.match(/^(\d+)\s+([0-9]+(?:\.[0-9]+)?)$/);
        if (!m) return await bot.sendMessage(chatId, 'ফরম্যাট:\nServiceID Amount\nউদাহরণ: 979 150');
        const serviceId = m[1];
        if (!db.serviceIds.includes(serviceId)) return await bot.sendMessage(chatId, '❌ এই Service ID আপনার তালিকায় নেই।');
        const amount = Number(m[2]);
        let base = Number(db.prices[serviceId]);
        if (!Number.isFinite(base)) {
          try { const all = await getServices(); const ss = selectedServiceInfo(all, serviceId); base = Number(ss?.providerRate || 0); } catch (_) { base = 0; }
        }
        if (state.type === 'set_price') db.prices[serviceId] = amount;
        else db.prices[serviceId] = state.type === 'increase_price' ? base + amount : Math.max(0, base - amount);
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, `✅ Service ${serviceId}-এর নতুন দাম/1K: ৳${money(db.prices[serviceId])}`, { reply_markup: adminKeyboard() });
      }
      if (state?.type === 'payment_change') {
        const number = text.trim();
        if (!/^[0-9+\-\s]{8,25}$/.test(number)) return await bot.sendMessage(chatId, '⚠️ সঠিক payment number দিন।');
        db.paymentNumbers = [number]; await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, `✅ Payment number পরিবর্তন হয়েছে:\n${number}`, { reply_markup: adminKeyboard() });
      }
      if (state?.type === 'payment_add') {
        const number = text.trim();
        if (!/^[0-9+\-\s]{8,25}$/.test(number)) return await bot.sendMessage(chatId, '⚠️ সঠিক payment number দিন।');
        if (!db.paymentNumbers.includes(number)) db.paymentNumbers.push(number);
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, `✅ Payment number যোগ হয়েছে:\n${number}`, { reply_markup: adminKeyboard() });
      }
      if (state?.type === 'payment_remove') {
        const number = text.trim(); db.paymentNumbers = db.paymentNumbers.filter(x => x !== number);
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, '✅ Payment number মুছে দেওয়া হয়েছে।', { reply_markup: adminKeyboard() });
      }
    }

    return await bot.sendMessage(chatId, `ℹ️ আমি পেয়েছি: ${text}\n\nনিচের মেনু থেকে একটি অপশন নির্বাচন করুন।`, { reply_markup: customerKeyboard(uid) });
  } catch (e) {
    console.error('Message handler error:', e.stack || e.message);
    try { await bot.sendMessage(chatId, `❌ Bot error: ${e.message || 'Unknown error'}\n\nRender Logs দেখুন।`); } catch (_) {}
  }
});

bot.onText(/^\/addpayment$/i, async msg => {
  await rememberUser(msg); if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ অনুমতি নেই।");
  setState(msg.from.id, { type: "payment_add" }); return bot.sendMessage(msg.chat.id, "💳 নতুন payment number লিখুন।");
});
bot.onText(/^\/removepayment$/i, async msg => {
  await rememberUser(msg); if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ অনুমতি নেই।");
  if (!db.paymentNumbers.length) return bot.sendMessage(msg.chat.id, "কোনো payment number নেই।");
  setState(msg.from.id, { type: "payment_remove" }); return bot.sendMessage(msg.chat.id, `যে number মুছবেন সেটি হুবহু পাঠান:\n\n${db.paymentNumbers.join("\n")}`);
});

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("Trusted BAZAAR Telegram SMM Bot is running."); }
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: true, database: Boolean(pool), webhookPath, adminConfigured: Boolean(ADMIN_ID), apiConfigured: Boolean(SMM_API_KEY) })); }
  if (req.method === "POST" && req.url === webhookPath) {
    let raw = ""; req.on("data", chunk => { raw += chunk; if (raw.length > 2 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => { try { await bot.processUpdate(JSON.parse(raw || "{}")); } catch (e) { console.error("Webhook error:", e.stack || e.message); } res.writeHead(200); res.end("OK"); }); return;
  }
  res.writeHead(404); res.end("Not found");
});

async function start() {
  try {
    await initDb();
    server.listen(PORT, "0.0.0.0", async () => {
      console.log(`Listening on 0.0.0.0:${PORT}`);
      try {
        // Use long polling instead of Render webhook. This avoids webhook routing/proxy issues
        // and makes Telegram updates reach the message/callback handlers directly.
        await bot.deleteWebHook({ drop_pending_updates: false });
        await bot.startPolling({
          restart: true,
          params: { timeout: 25, allowed_updates: ['message', 'callback_query'] }
        });
        console.log('Telegram long polling started successfully.');
      } catch (e) {
        console.error('Telegram polling startup failed:', e.response?.body || e.message);
      }
    });
  } catch (e) { console.error("Startup failed:", e.stack || e.message); process.exit(1); }
}
bot.on('polling_error', (err) => console.error('Telegram polling error:', err.response?.body || err.message));
bot.on('error', (err) => console.error('Telegram bot error:', err.message));

process.on("SIGTERM", async () => { try { await bot.stopPolling(); } catch (_) {} try { await bot.deleteWebHook(); } catch (_) {} try { if (pool) await pool.end(); } catch (_) {} server.close(() => process.exit(0)); });
start();
