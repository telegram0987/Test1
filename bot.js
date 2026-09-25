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
if (!DATABASE_URL) throw new Error("DATABASE_URL is required. Refusing to start with temporary in-memory storage, because customer/admin data must survive redeploys.");

const bot = new TelegramBot(BOT_TOKEN, { polling: false });
const webhookSecret = crypto.createHash("sha256").update(BOT_TOKEN).digest("hex").slice(0, 40);
const webhookPath = `/telegram/webhook/${webhookSecret}`;

const DEFAULT_SERVICE_IDS = ["979", "133", "174", "3758", "1753", "622", "893", "2194", "1850", "1722", "9445"];
const PAYMENT_METHODS = { bk: "বিকাশ", ng: "নগদ", bn: "বাইন্সাস" };
const PAYMENT_METHOD_CODES = Object.fromEntries(Object.entries(PAYMENT_METHODS).map(([code, label]) => [label, code]));
const SERVICE_CATEGORIES = [
  { id: "facebook", label: "📘 Facebook", pattern: /facebook|\bfb\b/i },
  { id: "instagram", label: "📸 Instagram", pattern: /instagram|\binsta\b/i },
  { id: "tiktok", label: "🎵 TikTok", pattern: /tiktok|tik\s*tok/i },
  { id: "youtube", label: "▶️ YouTube", pattern: /youtube|\byt\b/i },
  { id: "telegram", label: "✈️ Telegram", pattern: /telegram|\btg\b/i },
  { id: "twitter", label: "𝕏 X / Twitter", pattern: /twitter|x\.com|\bx\b/i },
  { id: "whatsapp", label: "🟢 WhatsApp", pattern: /whatsapp|\bwa\b/i },
  { id: "snapchat", label: "👻 Snapchat", pattern: /snapchat/i },
  { id: "linkedin", label: "💼 LinkedIn", pattern: /linkedin/i },
  { id: "pinterest", label: "📌 Pinterest", pattern: /pinterest/i },
  { id: "reddit", label: "🔴 Reddit", pattern: /reddit/i },
  { id: "threads", label: "🧵 Threads", pattern: /threads/i },
  { id: "twitch", label: "🟣 Twitch", pattern: /twitch/i },
  { id: "spotify", label: "🎧 Spotify", pattern: /spotify/i },
  { id: "website", label: "🌐 Website / SEO", pattern: /website|web\s*traffic|seo|google/i },
  { id: "other", label: "📦 Other Services", pattern: null }
];

const defaultDb = () => ({
  serviceIds: [...DEFAULT_SERVICE_IDS],
  prices: {},
  paymentNumbers: [],
  paymentMethods: { "বিকাশ": "", "নগদ": "", "বাইন্সাস": "" },
  managerPaymentMethods: {},
  users: {},
  orders: {},
  balances: {},
  deposits: {},
  managers: [],
  supportAgents: [],
  referral: { minOrder: 50, commissionRate: 0.10 }
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
  if (result.rows[0]?.data) {
    const saved = result.rows[0].data || {};
    db = { ...defaultDb(), ...saved, referral: { ...defaultDb().referral, ...(saved.referral || {}) } };
    normalizeDb();
  } else {
    normalizeDb();
    await saveDb();
  }
}

function normalizeDb() {
  if (!Array.isArray(db.serviceIds)) db.serviceIds = [...DEFAULT_SERVICE_IDS];
  db.serviceIds = db.serviceIds.map(String);
  if (!db.prices || typeof db.prices !== "object") db.prices = {};
  if (!Array.isArray(db.paymentNumbers)) db.paymentNumbers = [];
  if (!db.paymentMethods || typeof db.paymentMethods !== "object") db.paymentMethods = { "বিকাশ": "", "নগদ": "", "বাইন্সাস": "" };
  for (const method of ["বিকাশ", "নগদ", "বাইন্সাস"]) if (typeof db.paymentMethods[method] !== "string") db.paymentMethods[method] = "";
  if (!db.managerPaymentMethods || typeof db.managerPaymentMethods !== "object" || Array.isArray(db.managerPaymentMethods)) db.managerPaymentMethods = {};
  for (const [managerId, methods] of Object.entries(db.managerPaymentMethods)) {
    const clean = (methods && typeof methods === "object") ? methods : {};
    db.managerPaymentMethods[String(managerId)] = Object.fromEntries(["বিকাশ", "নগদ", "বাইন্সাস"].map(method => [method, typeof clean[method] === "string" ? clean[method] : ""]));
  }
  // Migrate old single/list payment numbers into bKash if needed.
  if (!db.paymentMethods["বিকাশ"] && db.paymentNumbers.length) db.paymentMethods["বিকাশ"] = db.paymentNumbers[0];
  db.paymentNumbers = Object.values(db.paymentMethods).filter(Boolean);
  if (!db.users || typeof db.users !== "object") db.users = {};
  if (!db.orders || typeof db.orders !== "object") db.orders = {};
  if (!db.balances || typeof db.balances !== "object") db.balances = {};
  if (!db.deposits || typeof db.deposits !== "object") db.deposits = {};
  if (!Array.isArray(db.managers)) db.managers = [];
  db.managers = [...new Set(db.managers.map(id => String(id).trim()).filter(id => /^\d{5,15}$/.test(id) && id !== ADMIN_ID))];
  if (!Array.isArray(db.supportAgents)) db.supportAgents = [];
  db.supportAgents = db.supportAgents.filter(agent => agent && typeof agent === "object" && /^[A-Za-z0-9_]{5,32}$/.test(String(agent.username || "")))
    .map(agent => ({ username: String(agent.username).replace(/^@/, ""), name: String(agent.name || agent.username).slice(0, 50) }));
  if (!db.referral || typeof db.referral !== "object") db.referral = { minOrder: 50, commissionRate: 0.10 };
  if (!Number.isFinite(Number(db.referral.minOrder))) db.referral.minOrder = 50;
  if (!Number.isFinite(Number(db.referral.commissionRate))) db.referral.commissionRate = 0.10;
}

let saveQueue = Promise.resolve();
function saveDb() {
  if (!pool) return Promise.resolve();

  // Queue writes, but take the JSON snapshot only when this write actually
  // starts. This prevents an older snapshot (for example from rememberUser())
  // from overwriting a newer price, customer, balance, order, or payment update
  // that happened while the previous write was still running.
  const write = async () => {
    normalizeDb();
    const snapshot = JSON.parse(JSON.stringify(db));
    await pool.query(
      `INSERT INTO bot_settings (id, data, updated_at) VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify(snapshot)]
    );
  };

  // A failed write must not permanently poison the queue. Later saves should
  // still be able to persist the latest in-memory state.
  const previous = saveQueue.catch(() => {});
  saveQueue = previous.then(write).catch(err => {
    console.error("Database save error:", err.stack || err.message);
    throw err;
  });
  return saveQueue;
}

function isOwner(id) { return Boolean(ADMIN_ID) && String(id) === ADMIN_ID; }
function isManager(id) { return db.managers.includes(String(id)); }
function isAdmin(id) { return isOwner(id) || isManager(id); }
function languageOf(id) { return db.users[String(id)]?.language === "en" ? "en" : "bn"; }
function localized(id, bangla, english) { return languageOf(id) === "en" ? english : bangla; }
function languagePickerMarkup() {
  return { inline_keyboard: [[
    { text: "বাংলা", callback_data: "language:bn" },
    { text: "English", callback_data: "language:en" }
  ]] };
}
async function showLanguagePicker(chatId, uid) {
  return bot.sendMessage(chatId, localized(uid, "🌐 আপনার পছন্দের ভাষা নির্বাচন করুন:", "🌐 Choose your preferred language:"), { reply_markup: languagePickerMarkup() });
}
async function notifyOwner(message, options) {
  if (!ADMIN_ID) return;
  try { await bot.sendMessage(ADMIN_ID, message, options); }
  catch (e) { console.error(`Owner notification failed:`, e.response?.body || e.message); }
}
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

// Periodically sync provider order status and notify customers when an order completes.
let statusSyncRunning = false;
async function syncOrderStatuses() {
  if (statusSyncRunning || !SMM_API_KEY) return;
  statusSyncRunning = true;
  try {
    const orders = Object.values(db.orders || {}).filter(o =>
      o && o.providerOrderId && !['Completed', 'Canceled', 'Cancelled', 'Failed', 'Partial'].includes(String(o.status || ''))
    );

    let changed = false;
    for (const order of orders.slice(-100)) {
      try {
        const data = await smm({ action: 'status', order: String(order.providerOrderId) });
        const providerStatus = String(data?.status || '').trim();
        if (!providerStatus) continue;

        const normalized = providerStatus.toLowerCase();
        const oldStatus = String(order.status || 'Submitted');
        const statusMap = {
          'completed': 'Completed',
          'complete': 'Completed',
          'partial': 'Partial',
          'canceled': 'Canceled',
          'cancelled': 'Canceled',
          'failed': 'Failed',
          'in progress': 'In Progress',
          'processing': 'Processing',
          'pending': 'Pending',
          'refunded': 'Refunded'
        };
        const newStatus = statusMap[normalized] || providerStatus;

        order.status = newStatus;
        order.providerStatus = providerStatus;
        if (data.start_count !== undefined) order.startCount = data.start_count;
        if (data.remains !== undefined) order.remains = data.remains;
        if (data.currency !== undefined) order.currency = data.currency;
        order.lastStatusCheck = new Date().toISOString();
        changed = true;

        // Notify only once when the provider reports the order as completed.
        if (newStatus === 'Completed' && !order.completionNotified) {
          order.completedAt = new Date().toISOString();
          order.completionNotified = true;

          // Referral commission: only after a provider-confirmed Completed order.
          const buyer = db.users[String(order.userId)] || {};
          const referrerId = String(buyer.referredBy || '');
          const minReferralOrder = Number(db.referral?.minOrder || 50);
          const referralRate = Number(db.referral?.commissionRate || 0.10);
          const referralCommission = 5;
          const refUser = db.users[referrerId] || { id: Number(referrerId) };
          if (!refUser.referralRewardedUsers || typeof refUser.referralRewardedUsers !== 'object') refUser.referralRewardedUsers = {};
          const alreadyRewarded = Boolean(refUser.referralRewardedUsers[String(order.userId)]);
          // Fixed ৳5 reward only once for each referred customer, after their first completed order of at least ৳50.
          if (referrerId && referrerId !== String(order.userId) && Number(order.cost || 0) >= minReferralOrder && !alreadyRewarded && !order.referralCommissionPaid) {
            setBalance(referrerId, getBalance(referrerId) + referralCommission);
            refUser.referralEarnings = Number(refUser.referralEarnings || 0) + referralCommission;
            refUser.referralRewardedUsers[String(order.userId)] = true;
            db.users[referrerId] = refUser;
            order.referralCommissionPaid = true;
            order.referralCommission = referralCommission;
            order.referralPaidTo = referrerId;
            try {
              await bot.sendMessage(referrerId, localized(referrerId, `🎁 রেফারেল পুরস্কার যোগ হয়েছে!\n\n🆔 অর্ডার: ${order.id}\n💵 কাস্টমারের অর্ডার: ৳${money(order.cost)}\n💰 পুরস্কার: ৳5.00\n💵 আপনার ব্যালেন্স: ৳${money(getBalance(referrerId))}`, `🎁 Referral reward added!\n\n🆔 Order: ${order.id}\n💵 Customer order: ৳${money(order.cost)}\n💰 Reward: ৳5.00\n💵 Your balance: ৳${money(getBalance(referrerId))}`), { reply_markup: customerKeyboard(Number(referrerId)) });
            } catch (notifyErr) {
              console.error(`Referral notification failed for ${referrerId}:`, notifyErr.response?.body || notifyErr.message);
            }
          }

          const customerText = localized(order.userId, `🎉 অর্ডার সম্পন্ন হয়েছে!\n\n🆔 অর্ডার: ${order.id}\n📌 সার্ভিস: ${order.serviceName || order.serviceId}\n🔢 পরিমাণ: ${order.quantity}\n💵 খরচ: ৳${money(order.cost)}\n📊 অবস্থা: ✅ সম্পন্ন${order.providerOrderId ? `\n🔢 Provider Order: ${order.providerOrderId}` : ''}`, `🎉 Order completed!\n\n🆔 Order: ${order.id}\n📌 Service: ${order.serviceName || order.serviceId}\n🔢 Quantity: ${order.quantity}\n💵 Cost: ৳${money(order.cost)}\n📊 Status: ✅ Completed${order.providerOrderId ? `\n🔢 Provider Order: ${order.providerOrderId}` : ''}`);
          try {
            await bot.sendMessage(String(order.userId), customerText, { reply_markup: customerKeyboard(order.userId) });
          } catch (notifyErr) {
            console.error(`Completion notification failed for ${order.id}:`, notifyErr.response?.body || notifyErr.message);
          }

          await notifyOwner(`✅ ORDER COMPLETED\n\n🆔 Order: ${order.id}\n👤 User: ${order.userId}\n📌 Service: ${order.serviceId}\n🔢 Quantity: ${order.quantity}\n📊 Status: Completed\n🔢 Provider Order: ${order.providerOrderId}`);
        }
      } catch (e) {
        console.error(`Status check failed for provider order ${order.providerOrderId}:`, e.response?.data || e.message);
      }
    }
    if (changed) await saveDb();
  } finally {
    statusSyncRunning = false;
  }
}

function customerKeyboard(userId) {
  const en = languageOf(userId) === "en";
  const rows = [
    [{ text: en ? "📋 Services" : "📋 সার্ভিস" }, { text: en ? "💰 Balance" : "💰 ব্যালেন্স" }],
    [{ text: en ? "💳 Add Balance" : "💳 ব্যালেন্স যোগ" }, { text: en ? "🛒 New Order" : "🛒 নতুন অর্ডার" }],
    [{ text: en ? "📦 My Orders" : "📦 আমার অর্ডার" }, { text: en ? "👥 Referral" : "👥 রেফারেল" }],
    [{ text: en ? "👤 Account Details" : "👤 অ্যাকাউন্ট তথ্য" }],
    [{ text: en ? "🆘 Support" : "🆘 সাপোর্ট" }, { text: "🌐 Language / ভাষা" }]
  ];
  if (isAdmin(userId)) rows.push([{ text: "⚙️ Admin Panel" }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}
function adminKeyboard(viewerId) {
  if (isManager(viewerId) && !isOwner(viewerId)) return { keyboard: [
    [{ text: "💳 Payment Methods" }],
    [{ text: "💳 Payment Requests" }],
    [{ text: "🔙 Customer Menu" }]
  ], resize_keyboard: true, is_persistent: true };
  const rows = [
    [{ text: "📋 Manage Services" }],
    [{ text: "➕ Add Service ID" }, { text: "➖ Remove Service ID" }],
    [{ text: "💰 Set Price" }, { text: "⬆️ Increase Price" }],
    [{ text: "⬇️ Decrease Price" }, { text: "💳 Payment Methods" }],
    [{ text: "💳 Payment Requests" }],
    [{ text: "👥 User Count" }],
    [{ text: "👤 Customer Details" }],
    [{ text: "🔙 Customer Menu" }]
  ];
  if (isOwner(viewerId)) {
    rows.splice(rows.length - 1, 0, [{ text: "💰 Manager Payment Summary" }]);
    rows.splice(rows.length - 1, 0, [{ text: "👥 Manage Managers" }]);
    rows.splice(rows.length - 1, 0, [{ text: "🆘 Support Agents" }]);
  }
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

const states = new Map();
function setState(id, state) { states.set(String(id), state); }
function getState(id) { return states.get(String(id)); }
function clearState(id) { states.delete(String(id)); }

function rememberUser(msg) {
  const id = String(msg.from.id);
  const previous = db.users[id] || {};
  db.users[id] = {
    ...previous,
    id: msg.from.id,
    username: msg.from.username || previous.username || "",
    firstName: msg.from.first_name || previous.firstName || "",
    lastSeen: new Date().toISOString()
  };
  return saveDb();
}
function normalizeButton(text) {
  const raw = String(text || '').normalize('NFKC').replace(/[\uFE0E\uFE0F]/g, '').trim();
  const clean = raw.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().toLowerCase();
  const aliases = {
    'services': 'services',
    'সার্ভিস': 'services',
    'balance': 'balance',
    'ব্যালেন্স': 'balance',
    'add balance': 'add balance',
    'ব্যালেন্স যোগ': 'add balance',
    'new order': 'new order',
    'নতুন অর্ডার': 'new order',
    'my orders': 'my orders',
    'আমার অর্ডার': 'my orders',
    'referral': 'referral',
    'রেফারেল': 'referral',
    'admin panel': 'admin panel',
    'manage managers': 'manage managers',
    'manager payment summary': 'manager payment summary',
    'support agents': 'support agents',
    'manage services': 'manage services',
    'add service id': 'add service id',
    'remove service id': 'remove service id',
    'set price': 'set price',
    'increase price': 'increase price',
    'decrease price': 'decrease price',
    'payment numbers': 'payment numbers',
    'payment methods': 'payment numbers',
    'change payment number': 'change payment number',
    'payment requests': 'payment requests',
    'support': 'support',
    'সাপোর্ট': 'support',
    'language ভাষা': 'language',
    'ভাষা language': 'language',
    'user count': 'user count',
    'customer details': 'customer details',
    'account details': 'account details',
    'অ্যাকাউন্ট তথ্য': 'account details',
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

function categoryIdForService(service) {
  const details = `${service.category || ""} ${service.type || ""} ${service.name || ""}`;
  return SERVICE_CATEGORIES.find(c => c.pattern && c.pattern.test(details))?.id || "other";
}

function groupSelectedServices(all) {
  const selected = all.filter(s => db.serviceIds.includes(String(s.service ?? s.id ?? "")));
  const groups = new Map(SERVICE_CATEGORIES.map(category => [category.id, { ...category, services: [] }]));
  for (const service of selected) groups.get(categoryIdForService(service)).services.push(service);
  return [...groups.values()].filter(group => group.services.length);
}

async function loadSelectedServiceGroups() {
  return groupSelectedServices(await getServices());
}

function categoryLabel(group, uid) {
  const labels = {
    facebook: ["📘 ফেসবুক", "📘 Facebook"], instagram: ["📸 ইন্সটাগ্রাম", "📸 Instagram"],
    tiktok: ["🎵 টিকটক", "🎵 TikTok"], youtube: ["▶️ ইউটিউব", "▶️ YouTube"],
    telegram: ["✈️ টেলিগ্রাম", "✈️ Telegram"], twitter: ["𝕏 এক্স / টুইটার", "𝕏 X / Twitter"],
    whatsapp: ["🟢 হোয়াটসঅ্যাপ", "🟢 WhatsApp"], snapchat: ["👻 স্ন্যাপচ্যাট", "👻 Snapchat"],
    linkedin: ["💼 লিংকডইন", "💼 LinkedIn"], pinterest: ["📌 পিন্টারেস্ট", "📌 Pinterest"],
    reddit: ["🔴 রেডিট", "🔴 Reddit"], threads: ["🧵 থ্রেডস", "🧵 Threads"],
    twitch: ["🟣 টুইচ", "🟣 Twitch"], spotify: ["🎧 স্পটিফাই", "🎧 Spotify"],
    website: ["🌐 ওয়েবসাইট / SEO", "🌐 Website / SEO"], other: ["📦 অন্যান্য সার্ভিস", "📦 Other Services"]
  };
  const pair = labels[group.id] || [group.label, group.label];
  return localized(uid, pair[0], pair[1]);
}

function categoryKeyboard(groups, callbackPrefix, uid) {
  const rows = groups.map(group => [{
    text: `${categoryLabel(group, uid)} (${group.services.length})`,
    callback_data: `${callbackPrefix}:${group.id}`
  }]);
  return { inline_keyboard: rows };
}

async function sendCustomerServices(chatId) {
  try {
    const groups = await loadSelectedServiceGroups();
    if (!groups.length) return bot.sendMessage(chatId, localized(chatId, "⚠️ আপনার নির্বাচিত কোনো সার্ভিস provider API-তে পাওয়া যায়নি।\n\nAdmin Panel → Manage Services থেকে ID পরীক্ষা করুন।", "⚠️ None of your selected services were found in the provider API.\n\nCheck the IDs in Admin Panel → Manage Services."));
    return bot.sendMessage(chatId, localized(chatId, "📋 Trusted BAZAAR Services\n\nএকটি ক্যাটাগরি নির্বাচন করুন:", "📋 Trusted BAZAAR Services\n\nChoose a category:"), { reply_markup: categoryKeyboard(groups, "browse_cat", chatId) });
  } catch (e) {
    console.error("Services error:", e.response?.data || e.message);
    return bot.sendMessage(chatId, localized(chatId, "❌ সার্ভিস আনা যায়নি। SMM_API_KEY/API URL এবং Render Logs পরীক্ষা করুন।", "❌ Could not load services. Check SMM_API_KEY/API URL and Render logs."));
  }
}

async function showCategoryServices(chatId, categoryId) {
  try {
    const groups = await loadSelectedServiceGroups();
    const group = groups.find(item => item.id === categoryId);
    if (!group) return bot.sendMessage(chatId, localized(chatId, "⚠️ এই ক্যাটাগরিতে কোনো সার্ভিস পাওয়া যায়নি।", "⚠️ No services found in this category."));
    const label = categoryLabel(group, chatId);
    let text = `${label} ${localized(chatId, "সার্ভিস", "Services")} (${group.services.length})\n\n`;
    const chunks = [];
    for (const service of group.services) {
      const serviceId = String(service.service ?? service.id);
      const price = db.prices[serviceId] !== undefined ? Number(db.prices[serviceId]) : Number(service.rate || 0);
      const line = localized(chatId, `🆔 ${serviceId}\n📌 ${service.name || "সার্ভিস"}\n💰 প্রতি ১K: ৳${money(price)}\n🔢 সর্বনিম্ন: ${service.min ?? "-"} | সর্বোচ্চ: ${service.max ?? "-"}\n\n`, `🆔 ${serviceId}\n📌 ${service.name || "Service"}\n💰 Price/1K: ৳${money(price)}\n🔢 Min: ${service.min ?? "-"} | Max: ${service.max ?? "-"}\n\n`);
      if ((text + line).length > 3500) { chunks.push(text); text = `${label} ${localized(chatId, "সার্ভিস", "Services")} (continued)\n\n`; }
      text += line;
    }
    if (text) chunks.push(text);
    for (let i = 0; i < chunks.length; i++) {
      const options = i === chunks.length - 1 ? { reply_markup: { inline_keyboard: [[{ text: localized(chatId, "🔙 ক্যাটাগরি", "🔙 Categories"), callback_data: "browse_categories" }]] } } : undefined;
      await bot.sendMessage(chatId, chunks[i], options);
    }
  } catch (e) {
    console.error("Category services error:", e.response?.data || e.message);
    return bot.sendMessage(chatId, localized(chatId, "❌ এই ক্যাটাগরির সার্ভিস আনা যায়নি।", "❌ Could not load services in this category."));
  }
}

async function showOrderCategory(chatId, uid, categoryId, page = 0) {
  try {
    const groups = await loadSelectedServiceGroups();
    const group = groups.find(item => item.id === categoryId);
    if (!group) return bot.sendMessage(chatId, localized(chatId, "⚠️ এই ক্যাটাগরিতে কোনো সার্ভিস পাওয়া যায়নি।", "⚠️ No services found in this category."));
    const pageSize = 85;
    const pageCount = Math.ceil(group.services.length / pageSize);
    const pageIndex = Math.min(Math.max(0, Number(page) || 0), Math.max(0, pageCount - 1));
    const pageServices = group.services.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
    const buttons = pageServices.map(service => {
      const sid = String(service.service ?? service.id);
      const price = db.prices[sid] !== undefined ? Number(db.prices[sid]) : Number(service.rate || 0);
      return [{ text: `${sid} • ${String(service.name || "Service").slice(0, 32)} • ৳${money(price)}/1K`, callback_data: `order_service:${sid}` }];
    });
    if (pageCount > 1) {
      const nav = [];
      if (pageIndex > 0) nav.push({ text: localized(uid, "⬅️ আগের পৃষ্ঠা", "⬅️ Previous"), callback_data: `order_cat:${categoryId}:${pageIndex - 1}` });
      if (pageIndex < pageCount - 1) nav.push({ text: localized(uid, "পরের পৃষ্ঠা ➡️", "Next ➡️"), callback_data: `order_cat:${categoryId}:${pageIndex + 1}` });
      buttons.push(nav);
    }
    buttons.push([{ text: localized(uid, "🔙 ক্যাটাগরি", "🔙 Categories"), callback_data: "order_categories" }]);
    return bot.sendMessage(chatId, localized(uid, `🛒 ${categoryLabel(group, uid)}\n\nএকটি সার্ভিস নির্বাচন করুন:${pageCount > 1 ? `\nপৃষ্ঠা ${pageIndex + 1}/${pageCount}` : ""}`, `🛒 ${categoryLabel(group, uid)}\n\nChoose a service:${pageCount > 1 ? `\nPage ${pageIndex + 1}/${pageCount}` : ""}`), { reply_markup: { inline_keyboard: buttons } });
  } catch (e) {
    console.error("Order category error:", e.response?.data || e.message);
    return bot.sendMessage(chatId, localized(chatId, "❌ এই ক্যাটাগরির সার্ভিস আনা যায়নি।", "❌ Could not load services in this category."));
  }
}

async function manageServices(chatId) {
  const ids = db.serviceIds;
  const text = `📋 Selected Service IDs: ${ids.length}\n\n` + ids.map((id, i) => `${i + 1}. ID: ${id} | Price/1K: ${db.prices[id] ?? "Provider rate"}`).join("\n");
  return bot.sendMessage(chatId, text);
}

async function showPaymentNumbers(chatId, viewerId) {
  const ownerType = isOwner(viewerId) ? "admin" : "manager";
  const pm = ownerType === "admin" ? db.paymentMethods : (db.managerPaymentMethods[String(viewerId)] || {});
  const label = ownerType === "admin" ? "Admin" : "আপনার Manager";
  const text = `💳 ${label} Payment Methods\n\n🟣 বিকাশ: ${pm["বিকাশ"] || "Not set"}\n🟢 নগদ: ${pm["নগদ"] || "Not set"}\n🔵 বাইন্যান্স: ${pm["বাইন্সাস"] || "Not set"}`;
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [
    [{ text: "🟣 Set বিকাশ", callback_data: `admin_pay_method:${ownerType === "admin" ? "a" : "m"}:bk` }],
    [{ text: "🟢 Set নগদ", callback_data: `admin_pay_method:${ownerType === "admin" ? "a" : "m"}:ng` }],
    [{ text: "🔵 Set বাইন্যান্স", callback_data: `admin_pay_method:${ownerType === "admin" ? "a" : "m"}:bn` }],
    [{ text: "🔙 Admin Panel", callback_data: "admin_panel" }]
  ] } });
}

async function showPaymentRequests(chatId, viewerId) {
  const pending = Object.values(db.deposits).filter(d => {
    if (d.status !== "pending") return false;
    const type = d.paymentOwner || "admin";
    return isOwner(viewerId) ? type === "admin" : type === "manager" && String(d.paymentManagerId) === String(viewerId);
  }).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!pending.length) return bot.sendMessage(chatId, "💳 Payment Requests\n\nকোনো pending payment নেই।", { reply_markup: adminKeyboard(chatId) });
  for (const d of pending.slice(0, 20)) {
    const text = `💳 Pending Payment\n\n🆔 ${d.id}\n👤 User: ${d.userId}\n💵 Amount: ${money(d.amount)}\n📱 Method/Number: ${d.paymentNumber}\n🔖 TxID: ${d.txId}\n🕒 ${d.createdAt}`;
    await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `dep_approve:${d.id}` }, { text: "❌ Reject", callback_data: `dep_reject:${d.id}` }]] } });
  }
}

async function showManagerPaymentSummary(chatId) {
  if (!isOwner(chatId)) return bot.sendMessage(chatId, "⛔ শুধু Admin এই হিসাব দেখতে পারবেন।");
  const managerIds = new Set([...(db.managers || []), ...Object.keys(db.managerPaymentMethods || {}), ...Object.values(db.deposits || {}).filter(d => d.paymentOwner === "manager" && d.paymentManagerId).map(d => String(d.paymentManagerId))]);
  if (!managerIds.size) return bot.sendMessage(chatId, "💰 Manager payment হিসাব\n\nকোনো manager বা payment record নেই।", { reply_markup: adminKeyboard(chatId) });
  const lines = [...managerIds].sort().map(id => {
    const records = Object.values(db.deposits || {}).filter(d => d.paymentOwner === "manager" && String(d.paymentManagerId) === id);
    const approved = records.filter(d => d.status === "approved");
    const pending = records.filter(d => d.status === "pending");
    const total = approved.reduce((sum, d) => sum + Number(d.amount || 0), 0);
    return `👤 Manager ID: ${id}\n✅ Approved: ${approved.length}টি | মোট ৳${money(total)}\n⏳ Pending: ${pending.length}টি | ৳${money(pending.reduce((sum, d) => sum + Number(d.amount || 0), 0))}`;
  });
  return bot.sendMessage(chatId, `💰 Manager Payment হিসাব\n\n${lines.join("\n\n")}`, { reply_markup: adminKeyboard(chatId) });
}

function formatUserLabel(user) {
  const username = user?.username ? `@${user.username}` : (user?.firstName || "No username");
  return `${username} • ${user?.id || "-"}`.slice(0, 64);
}

async function showManagers(chatId) {
  const ids = db.managers || [];
  const rows = ids.map(id => [{ text: `❌ Remove ${id}`, callback_data: `manager_remove:${id}` }]);
  rows.push([{ text: "➕ Add Manager", callback_data: "manager_add" }]);
  rows.push([{ text: "🔙 Admin Panel", callback_data: "admin_panel" }]);
  return bot.sendMessage(chatId, `👥 Manager System\n\nমোট Manager: ${ids.length}\n${ids.length ? ids.map((id, i) => `${i + 1}. ${id}`).join("\n") : "এখনো কোনো manager যোগ করা হয়নি।"}\n\nManager-রা Admin Panel ব্যবহার করতে পারবেন। শুধু Owner manager যোগ/বাদ দিতে পারবেন।`, { reply_markup: { inline_keyboard: rows } });
}

async function showSupportAgentsAdmin(chatId) {
  const agents = db.supportAgents || [];
  const rows = agents.map(agent => [{ text: `❌ Remove @${agent.username}`, callback_data: `support_agent_remove:${agent.username}` }]);
  rows.push([{ text: "➕ Add Support Agent", callback_data: "support_agent_add" }]);
  rows.push([{ text: "🔙 Admin Panel", callback_data: "admin_panel" }]);
  const list = agents.length ? agents.map((agent, i) => `${i + 1}. ${agent.name} (@${agent.username})`).join("\n") : "এখনো কোনো Support Agent যোগ করা হয়নি।";
  return bot.sendMessage(chatId, `🆘 Support Agents\n\n${list}\n\nএজেন্টের Telegram username যোগ করুন, যেমন: @support_name | Support Team`, { reply_markup: { inline_keyboard: rows } });
}

async function showCustomerSupport(chatId, uid) {
  const agents = db.supportAgents || [];
  if (!agents.length) return bot.sendMessage(chatId, localized(uid, "⚠️ এখনো কোনো Support Agent যোগ করা হয়নি।", "⚠️ No support agents are available yet."), { reply_markup: customerKeyboard(uid) });
  const buttons = agents.map(agent => [{ text: `💬 ${agent.name}`, url: `https://t.me/${agent.username}` }]);
  const text = localized(uid, "🆘 কাস্টমার সাপোর্ট\nনিচের এজেন্টের সাথে যোগাযোগ করুন:", "🆘 Customer Support\nChoose an agent to contact:");
  return bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: buttons } });
}

async function showAccountDetails(chatId, uid) {
  const user = db.users[String(uid)] || { id: uid };
  const orders = Object.values(db.orders || {}).filter(o => String(o.userId) === String(uid));
  const totalSpent = orders.reduce((sum, o) => sum + Number(o.cost || 0), 0);
  const completed = orders.filter(o => String(o.status || '').toLowerCase() === 'completed');
  const firstSeen = user.createdAt || user.joinedAt || '-';
  const lastSeen = user.lastSeen || '-';
  const bn = `👤 অ্যাকাউন্ট তথ্য\n\n🆔 User ID: ${user.id || uid}\n📛 ইউজারনেম: ${user.username ? '@' + user.username : 'নেই'}\n👤 নাম: ${user.firstName || 'নেই'}\n💰 বর্তমান ব্যালেন্স: ৳${money(getBalance(uid))}\n📦 মোট অর্ডার: ${orders.length}\n💵 অর্ডারের মোট মূল্য: ৳${money(totalSpent)}\n✅ সম্পন্ন অর্ডার: ${completed.length}\n🕒 সর্বশেষ সক্রিয়: ${lastSeen}\n🗓️ যোগদানের তারিখ: ${firstSeen}`;
  const en = `👤 Account Details\n\n🆔 User ID: ${user.id || uid}\n📛 Username: ${user.username ? '@' + user.username : 'Not set'}\n👤 Name: ${user.firstName || 'Not set'}\n💰 Current Balance: ৳${money(getBalance(uid))}\n📦 Total Orders: ${orders.length}\n💵 Total Order Value: ৳${money(totalSpent)}\n✅ Completed Orders: ${completed.length}\n🕒 Last Seen: ${lastSeen}\n🗓️ Joined: ${firstSeen}`;
  return bot.sendMessage(chatId, localized(uid, bn, en), { reply_markup: customerKeyboard(uid) });
}

async function showCustomerList(chatId) {
  const users = Object.values(db.users || {}).filter(u => !isAdmin(u?.id)).sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
  if (!users.length) return bot.sendMessage(chatId, '👤 Customer Details\n\nকোনো customer পাওয়া যায়নি।', { reply_markup: adminKeyboard(chatId) });
  const buttons = users.slice(0, 100).map(u => [{ text: formatUserLabel(u), callback_data: `admin_customer:${u.id}` }]);
  return bot.sendMessage(chatId, `👤 Customer Details\n\nমোট Customer: ${users.length}\nনিচে একজন customer নির্বাচন করুন:`, {
    reply_markup: { inline_keyboard: [...buttons, [{ text: '🔙 Admin Panel', callback_data: 'admin_panel' }]] }
  });
}

async function showCustomerDetails(chatId, customerId) {
  const user = db.users[String(customerId)];
  if (!user) return bot.sendMessage(chatId, '⚠️ Customer পাওয়া যায়নি।', { reply_markup: adminKeyboard(chatId) });
  const orders = Object.values(db.orders || {})
    .filter(o => String(o.userId) === String(customerId))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const totalSpent = orders.reduce((sum, o) => sum + Number(o.cost || 0), 0);
  const completedSpent = orders.filter(o => String(o.status || '').toLowerCase() === 'completed')
    .reduce((sum, o) => sum + Number(o.cost || 0), 0);
  const header = `👤 Customer Details\n\n🆔 User ID: ${user.id || customerId}\n📛 Username: ${user.username ? '@' + user.username : 'নেই'}\n👤 Name: ${user.firstName || 'নেই'}\n💰 Balance: ৳${money(getBalance(customerId))}\n📦 Total Orders: ${orders.length}\n💵 Total Order Value: ৳${money(totalSpent)}\n✅ Completed Value: ৳${money(completedSpent)}\n🕒 Last Seen: ${user.lastSeen || '-'}\n\n📜 Order History (শেষ 30টি)\n`;
  if (!orders.length) {
    return bot.sendMessage(chatId, header + '\nকোনো order history নেই।', { reply_markup: { inline_keyboard: [[{ text: '🔙 Customer List', callback_data: 'admin_customers' }], [{ text: '⚙️ Admin Panel', callback_data: 'admin_panel' }]] } });
  }
  const lines = orders.slice(0, 30).map((o, i) =>
    `${i + 1}. 🆔 ${o.id}\n   📌 Service: ${o.serviceName || ('Service ID ' + o.serviceId)}\n   🆔 Service ID: ${o.serviceId}\n   🔢 Qty: ${o.quantity}\n   💵 Cost: ৳${money(o.cost)}\n   📊 Status: ${o.status || 'Pending'}\n   🔢 Provider: ${o.providerOrderId || '-'}\n   🔗 ${o.link || '-'}\n   🕒 ${o.createdAt || '-'}`
  );
  let text = header + '\n' + lines.join('\n\n');
  // Telegram message limit safety: split long customer histories into chunks.
  const chunks = [];
  while (text.length > 3800) {
    let cut = text.lastIndexOf('\n\n', 3800);
    if (cut < 1000) cut = 3800;
    chunks.push(text.slice(0, cut));
    text = text.slice(cut).trimStart();
  }
  if (text) chunks.push(text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await bot.sendMessage(chatId, chunks[i], isLast ? { reply_markup: { inline_keyboard: [[{ text: '🔙 Customer List', callback_data: 'admin_customers' }], [{ text: '⚙️ Admin Panel', callback_data: 'admin_panel' }]] } } : undefined);
  }
}

async function handleAdminAction(id, uid, action) {
  if (!isOwner(uid) && !["admin panel", "payment numbers", "payment requests", "customer menu"].includes(action))
    return bot.sendMessage(id, "⛔ Manager access শুধু পেমেন্ট মেথড ও পেমেন্ট রিকোয়েস্টের জন্য।");
  if (action === "admin panel") { clearState(uid); return bot.sendMessage(id, "⚙️ Admin Panel", { reply_markup: adminKeyboard(uid) }); }
  if (action === "manage managers") {
    if (!isOwner(uid)) return bot.sendMessage(id, "⛔ শুধু Owner manager পরিচালনা করতে পারবেন।");
    clearState(uid); return showManagers(id);
  }
  if (action === "manage services") return manageServices(id);
  if (action === "add service id") { setState(uid, { type: "add_service" }); return bot.sendMessage(id, "➕ Service ID যোগ করুন।\nএকটি বা একাধিক ID comma/space দিয়ে দিতে পারবেন।\nউদাহরণ: 979,133,2000"); }
  if (action === "remove service id") { setState(uid, { type: "remove_service" }); return bot.sendMessage(id, "➖ যে Service ID বাদ দিতে চান দিন।\nউদাহরণ: 979,133"); }
  if (action === "set price") { setState(uid, { type: "set_price" }); return bot.sendMessage(id, "💰 Price/1K সেট করুন।\nফরম্যাট: ServiceID Price\nউদাহরণ: 979 150"); }
  if (action === "increase price") { setState(uid, { type: "increase_price" }); return bot.sendMessage(id, "⬆️ কত টাকা/1K বাড়াবেন?\nফরম্যাট: ServiceID Amount\nউদাহরণ: 979 20"); }
  if (action === "decrease price") { setState(uid, { type: "decrease_price" }); return bot.sendMessage(id, "⬇️ কত টাকা/1K কমাবেন?\nফরম্যাট: ServiceID Amount\nউদাহরণ: 979 20"); }
  if (action === "payment numbers") return showPaymentNumbers(id, uid);
  if (action === "change payment number") { setState(uid, { type: "payment_change" }); return bot.sendMessage(id, "✏️ নতুন payment number দিন。\nএটি বর্তমান payment number list replace করবে。"); }
  if (action === "payment requests") return showPaymentRequests(id, uid);
  if (action === "manager payment summary") return showManagerPaymentSummary(id);
  if (action === "support agents") {
    if (!isOwner(uid)) return bot.sendMessage(id, "⛔ শুধু Admin Support Agent পরিচালনা করতে পারবেন।");
    clearState(uid); return showSupportAgentsAdmin(id);
  }
  if (action === "user count") return bot.sendMessage(id, `👥 Registered users: ${Object.keys(db.users).length}`);
  if (action === "customer details") { clearState(uid); return showCustomerList(id); }
  if (action === "customer menu") { clearState(uid); return bot.sendMessage(id, "🏠 Customer Menu", { reply_markup: customerKeyboard(uid) }); }
}


async function getBotUsername() {
  const me = await bot.getMe();
  return String(me.username || "");
}

function getReferralLink(uid, username) {
  return `https://t.me/${username}?start=ref_${uid}`;
}

async function showReferral(chatId, uid) {
  const user = db.users[String(uid)] || {};
  let username = user.botUsername;
  if (!username) {
    username = await getBotUsername();
    user.botUsername = username;
    db.users[String(uid)] = user;
    await saveDb();
  }
  const referred = Object.values(db.users).filter(u => String(u.referredBy || '') === String(uid)).length;
  const earned = Number(user.referralEarnings || 0);
  const link = getReferralLink(uid, username);
  const min = money(db.referral.minOrder);
  const bn = `👥 রেফারেল প্রোগ্রাম\n\n🔗 আপনার রেফারেল লিংক:\n${link}\n\n👥 মোট রেফারেল: ${referred}\n💰 মোট কমিশন: ৳${money(earned)}\n\n🎁 আপনার লিংক দিয়ে আসা নতুন কাস্টমারের প্রথম ৳${min} বা তার বেশি মূল্যের অর্ডার সম্পন্ন হলে আপনি একবার ৳5 পাবেন।`;
  const en = `👥 Referral Program\n\n🔗 Your referral link:\n${link}\n\n👥 Total referrals: ${referred}\n💰 Total commission: ৳${money(earned)}\n\n🎁 You earn ৳5 once when a customer who joined through your link completes their first order of at least ৳${min}.`;
  return bot.sendMessage(chatId, localized(uid, bn, en), { reply_markup: customerKeyboard(uid) });
}

async function processReferralStart(msg, startArg) {
  const uid = String(msg.from.id);
  if (!startArg || !startArg.startsWith('ref_')) return;
  const referrerId = startArg.slice(4).trim();
  if (!/^\d+$/.test(referrerId) || referrerId === uid) return;
  if (!db.users[uid]) db.users[uid] = { id: msg.from.id };
  // A referral is locked to the first valid referrer and cannot be overwritten later.
  if (!db.users[uid].referredBy && db.users[referrerId]) {
    db.users[uid].referredBy = referrerId;
    db.users[uid].referredAt = new Date().toISOString();
    await saveDb();
  }
}

async function startNewOrder(chatId, uid) {
  try {
    const groups = await loadSelectedServiceGroups();
    if (!groups.length) return bot.sendMessage(chatId, localized(uid, "⚠️ কোনো সার্ভিস পাওয়া যায়নি। Admin আগে Service ID যোগ করুন।", "⚠️ No services found. Ask the Admin to add service IDs."));
    return bot.sendMessage(chatId, localized(uid, `🛒 নতুন অর্ডার\n\n💰 আপনার ব্যালেন্স: ৳${money(getBalance(uid))}\n\nআগে একটি ক্যাটাগরি নির্বাচন করুন:`, `🛒 New Order\n\n💰 Your balance: ৳${money(getBalance(uid))}\n\nChoose a category first:`), { reply_markup: categoryKeyboard(groups, "order_cat", uid) });
  } catch (e) {
    console.error("New order services error:", e.response?.data || e.message);
    return bot.sendMessage(chatId, localized(uid, "❌ সার্ভিস তালিকা আনা যায়নি।", "❌ Could not load the service list."));
  }
}

async function showAddBalance(chatId) {
  const buttons = [];
  for (const [method, number] of Object.entries(db.paymentMethods || {})) {
    const code = PAYMENT_METHOD_CODES[method];
    if (number && code) buttons.push([{ text: `👑 Admin • ${method} • ${number}`, callback_data: `deposit_method:a:${code}` }]);
  }
  for (const managerId of db.managers || []) {
    const methods = db.managerPaymentMethods?.[String(managerId)] || {};
    for (const [method, number] of Object.entries(methods)) {
      const code = PAYMENT_METHOD_CODES[method];
      if (number && code) buttons.push([{ text: `👤 Manager • ${method} • ${number}`, callback_data: `deposit_method:m:${managerId}:${code}` }]);
    }
  }
  if (!buttons.length) return bot.sendMessage(chatId, localized(chatId, "⚠️ এখনো কোনো Admin বা Manager পেমেন্ট মেথড সেট করা হয়নি।", "⚠️ No Admin or Manager payment methods have been set yet."));
  clearState(chatId);
  return bot.sendMessage(chatId, localized(chatId, "💳 ব্যালেন্স যোগ\n\nযে নম্বরে টাকা পাঠাবেন সেটি নির্বাচন করুন। Admin ও Manager-এর নম্বর আলাদা করে দেখানো হয়েছে:", "💳 Add Balance\n\nChoose the number you will pay. Admin and Manager accounts are shown separately:"), { reply_markup: { inline_keyboard: buttons } });
}

async function submitDeposit(chatId, uid, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return bot.sendMessage(chatId, localized(uid, "⚠️ সঠিক পরিমাণ লিখুন। উদাহরণ: 100", "⚠️ Enter a valid amount. Example: 100"));
  const state = getState(uid);
  const method = state?.paymentMethod || "";
  const paymentOwner = state?.paymentOwner || "admin";
  const managerId = String(state?.paymentManagerId || "");
  const number = paymentOwner === "manager"
    ? db.managerPaymentMethods?.[managerId]?.[method] || ""
    : db.paymentMethods?.[method] || "";
  if (!method || !number || (paymentOwner === "manager" && !db.managers.includes(managerId)))
    return bot.sendMessage(chatId, localized(uid, "⚠️ এই পেমেন্ট মেথড আর চালু নেই। ব্যালেন্স যোগ থেকে নতুন নম্বর বেছে নিন।", "⚠️ This payment method is no longer available. Choose another number from Add Balance."));
  setState(uid, { type: "deposit_txid", amount, paymentMethod: method, paymentNumber: number, paymentOwner, paymentManagerId: paymentOwner === "manager" ? managerId : "" });
  return bot.sendMessage(chatId, localized(uid, `💵 পরিমাণ: ৳${money(amount)}\n💳 মেথড: ${method}\n📱 নম্বর: ${number}\n\nএখন Transaction ID/TrxID পাঠান।\nউদাহরণ: TX123456789`, `💵 Amount: ৳${money(amount)}\n💳 Method: ${method}\n📱 Number: ${number}\n\nNow send your transaction ID/TrxID.\nExample: TX123456789`));
}

bot.onText(/^\/start(?:\s+(.+))?$/i, async (msg, match) => {
  await rememberUser(msg);
  const arg = String(match?.[1] || '').trim();
  await processReferralStart(msg, arg);
  clearState(msg.from.id);
  if (!db.users[String(msg.from.id)]?.language) return showLanguagePicker(msg.chat.id, msg.from.id);
  await bot.sendMessage(msg.chat.id, localized(msg.from.id, "👋 স্বাগতম!\n\n🤖 Trusted BAZAAR SMM Bot\n\nনিচের মেনু থেকে অপশন নির্বাচন করুন।", "👋 Welcome!\n\n🤖 Trusted BAZAAR SMM Bot\n\nChoose an option from the menu below."), { reply_markup: customerKeyboard(msg.from.id) });
});
bot.onText(/^\/admin$/i, async msg => {
  await rememberUser(msg); if (!isAdmin(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ এই মেনু শুধু Admin/Manager-এর জন্য。");
  clearState(msg.from.id); return bot.sendMessage(msg.chat.id, "⚙️ Admin Panel", { reply_markup: adminKeyboard(msg.from.id) });
});

bot.onText(/^\/myid$/i, async msg => bot.sendMessage(msg.chat.id, `আপনার Telegram User ID: ${msg.from.id}`));

bot.on("callback_query", async q => {
  try {
    const uid = q.from.id, chatId = q.message.chat.id, data = String(q.data || "");
    await bot.answerCallbackQuery(q.id);
    if (data.startsWith("language:")) {
      const language = data.slice("language:".length);
      if (!["bn", "en"].includes(language)) return;
      db.users[String(uid)] = { ...(db.users[String(uid)] || { id: uid }), language };
      await saveDb();
      return bot.sendMessage(chatId, language === "en" ? "✅ Language set to English." : "✅ ভাষা বাংলা করা হয়েছে।", { reply_markup: customerKeyboard(uid) });
    }
    if (data === "browse_categories") return sendCustomerServices(chatId);
    if (data.startsWith("browse_cat:")) return showCategoryServices(chatId, data.slice("browse_cat:".length));
    if (data === "order_categories") return startNewOrder(chatId, uid);
    if (data.startsWith("order_cat:")) {
      const [, categoryId, page] = data.split(":");
      return showOrderCategory(chatId, uid, categoryId, page);
    }
    if (data.startsWith("order_service:")) {
      const sid = data.split(":")[1];
      const all = await getServices(); const s = selectedServiceInfo(all, sid);
      if (!s) return bot.sendMessage(chatId, localized(uid, "❌ সার্ভিস পাওয়া যায়নি।", "❌ Service not found."));
      setState(uid, { type: "order_link", serviceId: sid, service: s });
      return bot.sendMessage(chatId, localized(uid, `📌 ${s.name}\n💰 দাম: ৳${money(s.price)}/১K\n🔢 সর্বনিম্ন: ${s.min || "-"} | সর্বোচ্চ: ${s.max || "-"}\n\n🔗 আপনার Link/Username পাঠান:`, `📌 ${s.name}\n💰 Price: ৳${money(s.price)}/1K\n🔢 Min: ${s.min || "-"} | Max: ${s.max || "-"}\n\n🔗 Send your link/username:`));
    }
    if (data.startsWith("deposit_method:")) {
      const parts = data.split(":");
      let paymentOwner = "admin", managerId = "", method = "";
      if (parts.length === 2) {
        // Old payment buttons are treated as Admin-owned for compatibility.
        method = parts[1];
      } else if (parts[1] === "a") {
        method = PAYMENT_METHODS[parts[2]] || "";
      } else if (parts[1] === "m") {
        paymentOwner = "manager"; managerId = String(parts[2] || ""); method = PAYMENT_METHODS[parts[3]] || "";
      }
      const number = paymentOwner === "manager"
        ? db.managerPaymentMethods?.[managerId]?.[method] || ""
        : db.paymentMethods?.[method] || "";
      if (paymentOwner === "manager" && !db.managers.includes(managerId)) return bot.sendMessage(chatId, localized(uid, "⚠️ এই Manager পেমেন্ট অ্যাকাউন্ট আর চালু নেই।", "⚠️ This Manager payment account is no longer active."));
      if (!number) return bot.sendMessage(chatId, localized(uid, "⚠️ এই পেমেন্ট মেথড এখনো সেট করা হয়নি।", "⚠️ This payment method has not been set yet."));
      setState(uid, { type: "deposit_amount_method", paymentMethod: method, paymentNumber: number, paymentOwner, paymentManagerId: managerId });
      return bot.sendMessage(chatId, localized(uid, `💳 ${paymentOwner === "admin" ? "Admin" : `Manager ${managerId}`} • ${method}\n📱 নম্বর: ${number}\n\nকত টাকা পাঠিয়েছেন লিখুন।\nউদাহরণ: 100`, `💳 ${paymentOwner === "admin" ? "Admin" : `Manager ${managerId}`} • ${method}\n📱 Number: ${number}\n\nEnter the amount you paid.\nExample: 100`));
    }
    if (data === "admin_panel") {
      if (!isAdmin(uid)) return;
      clearState(uid);
      return bot.sendMessage(chatId, "⚙️ Admin Panel", { reply_markup: adminKeyboard(uid) });
    }
    if (data === "manager_add") {
      if (!isOwner(uid)) return bot.sendMessage(chatId, "⛔ শুধু Owner manager যোগ করতে পারবেন।");
      setState(uid, { type: "manager_add" });
      return bot.sendMessage(chatId, "➕ Manager-এর Telegram numeric User ID পাঠান।\nউদাহরণ: 123456789\nতাকে /myid পাঠিয়ে ID জানাতে বলুন।");
    }
    if (data === "support_agent_add") {
      if (!isOwner(uid)) return bot.sendMessage(chatId, "⛔ শুধু Admin Support Agent যোগ করতে পারবেন।");
      setState(uid, { type: "support_agent_add" });
      return bot.sendMessage(chatId, "➕ Telegram username পাঠান।\nউদাহরণ: @support_name | Support Team\nনাম বাদ দিলে username-টাই নাম হিসেবে দেখাবে।");
    }
    if (data.startsWith("support_agent_remove:")) {
      if (!isOwner(uid)) return bot.sendMessage(chatId, "⛔ শুধু Admin Support Agent বাদ দিতে পারবেন।");
      const username = data.slice("support_agent_remove:".length).toLowerCase();
      db.supportAgents = db.supportAgents.filter(agent => agent.username.toLowerCase() !== username);
      await saveDb();
      return showSupportAgentsAdmin(chatId);
    }
    if (data.startsWith("manager_remove:")) {
      if (!isOwner(uid)) return bot.sendMessage(chatId, "⛔ শুধু Owner manager বাদ দিতে পারবেন।");
      const managerId = data.split(":")[1];
      if (!db.managers.includes(managerId)) return showManagers(chatId);
      const openPayments = Object.values(db.deposits || {}).filter(d => d.status === "pending" && d.paymentOwner === "manager" && String(d.paymentManagerId) === managerId).length;
      if (openPayments) return bot.sendMessage(chatId, `⚠️ এই Manager-এর ${openPayments}টি payment request pending আছে। আগে সেগুলো resolve করুন, তারপর Manager-কে বাদ দিন।`, { reply_markup: { inline_keyboard: [[{ text: "🔙 Admin Panel", callback_data: "admin_panel" }]] } });
      db.managers = db.managers.filter(id => id !== managerId);
      await saveDb();
      try { await bot.sendMessage(managerId, "ℹ️ আপনার Manager access সরিয়ে দেওয়া হয়েছে।"); } catch (_) {}
      await bot.sendMessage(chatId, `✅ Manager ${managerId} সরানো হয়েছে।`);
      return showManagers(chatId);
    }
    if (data === "admin_customers") {
      if (!isOwner(uid)) return;
      clearState(uid);
      return showCustomerList(chatId);
    }
    if (data.startsWith("admin_customer:")) {
      if (!isOwner(uid)) return;
      const customerId = data.split(":")[1];
      clearState(uid);
      return showCustomerDetails(chatId, customerId);
    }
    if (data.startsWith("admin_pay_method:")) {
      if (!isAdmin(uid)) return;
      const [, ownerType, code] = data.split(":");
      const method = PAYMENT_METHODS[code];
      if (!method) return;
      if (ownerType === "a" && !isOwner(uid)) return;
      if (ownerType === "m" && !isManager(uid)) return;
      if (!['a', 'm'].includes(ownerType)) return;
      setState(uid, { type: "payment_method_set", method, paymentOwner: ownerType === "a" ? "admin" : "manager" });
      return bot.sendMessage(chatId, `✏️ ${method}-এর payment number/account number পাঠান।`);
    }
    if (data === "admin_pay_add") {
      if (!isOwner(uid)) return;
      setState(uid, { type: "payment_add" });
      return bot.sendMessage(chatId, "➕ নতুন payment number লিখুন।");
    }
    if (data === "admin_pay_change") {
      if (!isOwner(uid)) return;
      setState(uid, { type: "payment_change" });
      return bot.sendMessage(chatId, "✏️ নতুন payment number দিন। এটি বর্তমান payment number replace করবে।");
    }
    if (data === "admin_pay_remove") {
      if (!isOwner(uid)) return;
      if (!db.paymentNumbers.length) return bot.sendMessage(chatId, "⚠️ কোনো payment number নেই।");
      setState(uid, { type: "payment_remove" });
      return bot.sendMessage(chatId, `🗑️ যে payment number মুছবেন সেটি হুবহু পাঠান:\n\n${db.paymentNumbers.join("\n")}`);
    }
    if (data.startsWith("dep_approve:") || data.startsWith("dep_reject:")) {
      if (!isAdmin(uid)) return;
      const [action, depId] = data.split(":"); const d = db.deposits[depId];
      if (!d || d.status !== "pending") return bot.sendMessage(chatId, "⚠️ এই payment request আর pending নেই।");
      const paymentOwner = d.paymentOwner || "admin";
      const canReview = paymentOwner === "manager"
        ? isManager(uid) && String(d.paymentManagerId) === String(uid)
        : isOwner(uid);
      if (!canReview) return bot.sendMessage(chatId, "⛔ এই payment request অন্য account-এর। সংশ্লিষ্ট payment account-এর owner-ই এটি approve/reject করতে পারবেন।");
      if (action === "dep_approve") {
        d.status = "approved"; d.approvedAt = new Date().toISOString(); d.approvedBy = uid;
        setBalance(d.userId, getBalance(d.userId) + Number(d.amount));
        await saveDb();
        await bot.sendMessage(d.userId, localized(d.userId, `✅ আপনার পেমেন্ট অনুমোদিত হয়েছে।\n💵 যোগ হয়েছে: ৳${money(d.amount)}\n💰 নতুন ব্যালেন্স: ৳${money(getBalance(d.userId))}`, `✅ Your payment was approved.\n💵 Added: ৳${money(d.amount)}\n💰 New balance: ৳${money(getBalance(d.userId))}`), { reply_markup: customerKeyboard(d.userId) });
        return bot.sendMessage(chatId, `✅ Payment ${depId} approved.\nUser: ${d.userId}\nAmount: ৳${money(d.amount)}`, { reply_markup: adminKeyboard(chatId) });
      }
      d.status = "rejected"; d.rejectedAt = new Date().toISOString(); d.rejectedBy = uid;
      await saveDb();
      await bot.sendMessage(d.userId, localized(d.userId, `❌ আপনার পেমেন্ট রিকোয়েস্ট বাতিল হয়েছে।\n🆔 ${depId}`, `❌ Your payment request was rejected.\n🆔 ${depId}`));
      return bot.sendMessage(chatId, `❌ Payment ${depId} rejected.`, { reply_markup: adminKeyboard(chatId) });
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
      const adminActions = new Set(isOwner(uid) ? [
        'admin panel','manage services','add service id','remove service id','set price',
        'increase price','decrease price','payment numbers','change payment number',
        'payment requests','user count','customer details','customer menu','manage managers','manager payment summary','support agents'
      ] : ['admin panel','payment numbers','payment requests','customer menu']);
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
      return await bot.sendMessage(chatId, localized(uid, `💰 আপনার ব্যালেন্স\n\n৳${money(getBalance(uid))}`, `💰 Your Balance\n\n৳${money(getBalance(uid))}`), { reply_markup: customerKeyboard(uid) });
    }
    if (action === 'account details') {
      clearState(uid);
      return await showAccountDetails(chatId, uid);
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
      if (!orders.length) return await bot.sendMessage(chatId, localized(uid, '📦 আমার অর্ডার\n\nএখনো কোনো অর্ডার নেই।', '📦 My Orders\n\nYou have no orders yet.'), { reply_markup: customerKeyboard(uid) });
      const lines = orders.slice(-20).reverse().map(o => localized(uid, `🆔 ${o.id}\n📌 সার্ভিস: ${o.serviceName || o.serviceId}\n🔗 ${o.link}\n🔢 পরিমাণ: ${o.quantity}\n💵 মূল্য: ৳${money(o.cost)}\n📊 অবস্থা: ${o.status || 'Pending'}${o.providerOrderId ? `\n🔢 Provider Order: ${o.providerOrderId}` : ''}`, `🆔 ${o.id}\n📌 Service: ${o.serviceName || o.serviceId}\n🔗 ${o.link}\n🔢 Quantity: ${o.quantity}\n💵 Cost: ৳${money(o.cost)}\n📊 Status: ${o.status || 'Pending'}${o.providerOrderId ? `\n🔢 Provider Order: ${o.providerOrderId}` : ''}`));
      return await bot.sendMessage(chatId, localized(uid, `📦 আমার অর্ডার\n\n${lines.join('\n\n')}`, `📦 My Orders\n\n${lines.join('\n\n')}`), { reply_markup: customerKeyboard(uid) });
    }
    if (action === 'referral') {
      clearState(uid);
      return await showReferral(chatId, uid);
    }
    if (action === 'support') {
      clearState(uid);
      return await showCustomerSupport(chatId, uid);
    }
    if (action === 'language') {
      clearState(uid);
      return await showLanguagePicker(chatId, uid);
    }

    const state = getState(uid);
    console.log(`[STATE] uid=${uid} state=${JSON.stringify(state || null)}`);

    if (state?.type === 'deposit_amount_method') {
      return await submitDeposit(chatId, uid, Number(text.replace(/,/g, '')));
    }
    if (state?.type === 'deposit_amount') {
      return await submitDeposit(chatId, uid, Number(text.replace(/,/g, '')));
    }
    if (state?.type === 'deposit_txid') {
      const txId = text.trim();
      if (txId.length < 3 || txId.length > 100) return await bot.sendMessage(chatId, localized(uid, '⚠️ সঠিক Transaction ID দিন।', '⚠️ Enter a valid transaction ID.'));
      const depId = `DEP-${Date.now()}-${String(uid).slice(-5)}`;
      const paymentOwner = state.paymentOwner || 'admin';
      const paymentManagerId = paymentOwner === 'manager' ? String(state.paymentManagerId || '') : '';
      db.deposits[depId] = { id: depId, userId: uid, amount: Number(state.amount), paymentMethod: state.paymentMethod || '', paymentNumber: state.paymentNumber || '', paymentOwner, paymentManagerId, txId, status: 'pending', createdAt: new Date().toISOString() };
      await saveDb(); clearState(uid);
      await bot.sendMessage(chatId, localized(uid, `✅ পেমেন্ট রিকোয়েস্ট পাঠানো হয়েছে।\n🆔 ${depId}\n💵 পরিমাণ: ৳${money(state.amount)}\n🔖 TxID: ${txId}\n\nনির্বাচিত payment account-এর owner অনুমোদন করলে ব্যালেন্স যোগ হবে।`, `✅ Payment request submitted.\n🆔 ${depId}\n💵 Amount: ৳${money(state.amount)}\n🔖 TxID: ${txId}\n\nYour balance will be added after the selected payment account owner approves it.`), { reply_markup: customerKeyboard(uid) });
      const reviewerId = paymentOwner === 'manager' ? paymentManagerId : ADMIN_ID;
      if (reviewerId) {
        try {
          await bot.sendMessage(reviewerId, `🔔 নতুন payment request এসেছে।\n🆔 ${depId}\n👤 User: ${uid}\n💵 Amount: ৳${money(state.amount)}\n💳 Account: ${paymentOwner === 'manager' ? `Manager ${paymentManagerId}` : 'Admin'} • ${state.paymentMethod}\n📱 Number: ${state.paymentNumber}\n🔖 TxID: ${txId}`, { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `dep_approve:${depId}` }, { text: '❌ Reject', callback_data: `dep_reject:${depId}` }]] } });
        } catch (notifyErr) { console.error(`Payment notification failed for ${reviewerId}:`, notifyErr.response?.body || notifyErr.message); }
      }
      return;
    }

    if (state?.type === 'order_link') {
      if (!text) return await bot.sendMessage(chatId, localized(uid, '⚠️ একটি Link দিন।', '⚠️ Send a link.'));
      setState(uid, { ...state, type: 'order_quantity', link: text });
      return await bot.sendMessage(chatId, localized(uid, `🔢 পরিমাণ লিখুন।\nসর্বনিম্ন: ${state.service.min || '-'}\nসর্বোচ্চ: ${state.service.max || '-'}\n\nউদাহরণ: 1000`, `🔢 Enter quantity.\nMin: ${state.service.min || '-'}\nMax: ${state.service.max || '-'}\n\nExample: 1000`));
    }
    if (state?.type === 'order_quantity') {
      const quantity = Number(text.replace(/,/g, ''));
      const min = Number(state.service.min || 0), max = Number(state.service.max || Number.MAX_SAFE_INTEGER);
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity < min || quantity > max) return await bot.sendMessage(chatId, localized(uid, `⚠️ পরিমাণটি সঠিক নয়। সর্বনিম্ন ${min}, সর্বোচ্চ ${max}।`, `⚠️ Invalid quantity. Minimum ${min}, maximum ${max}.`));
      const cost = Number(state.service.price) * quantity / 1000;
      if (getBalance(uid) < cost) {
        clearState(uid);
        return await bot.sendMessage(chatId, localized(uid, `❌ আপনার ব্যালেন্স কম।\nপ্রয়োজন: ৳${money(cost)}\nবর্তমান: ৳${money(getBalance(uid))}\n\nআগে 💳 ব্যালেন্স যোগ করুন।`, `❌ Insufficient balance.\nRequired: ৳${money(cost)}\nAvailable: ৳${money(getBalance(uid))}\n\nPlease use 💳 Add Balance first.`), { reply_markup: customerKeyboard(uid) });
      }
      const orderId = `ORD-${Date.now()}-${String(uid).slice(-5)}`;
      try {
        const result = await smm({ action: 'add', service: state.serviceId, link: state.link, quantity: String(quantity) });
        if (result?.error) throw new Error(String(result.error));
        const providerOrderId = result?.order ? String(result.order) : '';
        setBalance(uid, getBalance(uid) - cost);
        db.orders[orderId] = { id: orderId, userId: uid, serviceId: state.serviceId, serviceName: state.service?.name || `Service ${state.serviceId}`, link: state.link, quantity, cost, status: 'Submitted', providerOrderId, createdAt: new Date().toISOString() };
        await saveDb(); clearState(uid);

        // Notify the owner and all currently active managers.
        const adminText = `🔔 NEW ORDER RECEIVED\n\n🆔 Order: ${orderId}\n👤 User ID: ${uid}\n${db.users[String(uid)]?.username ? `📛 Username: @${db.users[String(uid)].username}\n` : ''}📌 Service ID: ${state.serviceId}\n🔗 Link: ${state.link}\n🔢 Quantity: ${quantity}\n💵 Customer Cost: ৳${money(cost)}\n💰 User Balance: ৳${money(getBalance(uid))}\n📊 Status: Submitted${providerOrderId ? `\n🔢 Provider Order: ${providerOrderId}` : ''}\n🌐 API: ${SMM_API_URL}`;
        await notifyOwner(adminText, { reply_markup: { inline_keyboard: [[{ text: '📋 Admin Panel', callback_data: 'admin_panel' }]] } });

        return await bot.sendMessage(chatId, localized(uid, `✅ অর্ডার সফলভাবে পাঠানো হয়েছে!\n\n🆔 ${orderId}\n📌 সার্ভিস: ${state.service?.name || state.serviceId}\n🔢 পরিমাণ: ${quantity}\n💵 খরচ: ৳${money(cost)}\n💰 ব্যালেন্স: ৳${money(getBalance(uid))}${providerOrderId ? `\n🔢 Provider Order: ${providerOrderId}` : ''}`, `✅ Order submitted successfully!\n\n🆔 ${orderId}\n📌 Service: ${state.service?.name || state.serviceId}\n🔢 Quantity: ${quantity}\n💵 Cost: ৳${money(cost)}\n💰 Balance: ৳${money(getBalance(uid))}${providerOrderId ? `\n🔢 Provider Order: ${providerOrderId}` : ''}`), { reply_markup: customerKeyboard(uid) });
      } catch (e) {
        console.error('Provider order error:', e.response?.data || e.message);
        await notifyOwner(`⚠️ ORDER FAILED

👤 User ID: ${uid}
📌 Service ID: ${state.serviceId}
🔗 Link: ${state.link}
🔢 Quantity: ${quantity}
💵 Intended Cost: ৳${money(cost)}
❌ Error: ${e.response?.data?.error || e.message}`);
        return await bot.sendMessage(chatId, localized(uid, `❌ অর্ডারটি পাঠানো যায়নি।\n\n${e.response?.data?.error || e.message}\n\nআপনার ব্যালেন্স কাটা হয়নি।`, `❌ Could not submit the order.\n\n${e.response?.data?.error || e.message}\n\nYour balance was not charged.`));
      }
    }

    if (isAdmin(uid)) {
      if (!isOwner(uid) && state && state.type !== 'payment_method_set') {
        clearState(uid);
        return bot.sendMessage(chatId, '⛔ Manager access শুধু পেমেন্ট মেথড ও পেমেন্ট রিকোয়েস্টের জন্য।', { reply_markup: adminKeyboard(uid) });
      }
      if (state?.type === 'manager_add') {
        if (!isOwner(uid)) { clearState(uid); return bot.sendMessage(chatId, '⛔ শুধু Owner manager যোগ করতে পারবেন।'); }
        const managerId = text.trim();
        if (!/^\d{5,15}$/.test(managerId)) return bot.sendMessage(chatId, '⚠️ বৈধ numeric Telegram User ID দিন।');
        if (managerId === ADMIN_ID) { clearState(uid); return bot.sendMessage(chatId, '⚠️ Owner-কে manager হিসেবে যোগ করার দরকার নেই।'); }
        if (db.managers.includes(managerId)) { clearState(uid); return bot.sendMessage(chatId, 'ℹ️ এই ID আগে থেকেই manager।', { reply_markup: adminKeyboard(uid) }); }
        db.managers.push(managerId);
        await saveDb(); clearState(uid);
        try { await bot.sendMessage(managerId, '✅ আপনাকে Trusted BAZAAR bot-এর Manager হিসেবে যোগ করা হয়েছে। /admin লিখে প্যানেল খুলুন।'); } catch (_) {}
        await bot.sendMessage(chatId, `✅ Manager যোগ হয়েছে: ${managerId}\nতাকে bot-এ /start দিতে বলুন, তারপর /admin ব্যবহার করতে পারবে।`, { reply_markup: adminKeyboard(uid) });
        return showManagers(chatId);
      }
      if (state?.type === 'support_agent_add') {
        if (!isOwner(uid)) { clearState(uid); return bot.sendMessage(chatId, '⛔ শুধু Admin Support Agent যোগ করতে পারবেন।'); }
        const [rawUsername, ...nameParts] = text.split('|');
        const username = rawUsername.trim().replace(/^@/, '');
        const displayName = nameParts.join('|').trim() || username;
        if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) return bot.sendMessage(chatId, '⚠️ বৈধ Telegram username দিন (কমপক্ষে ৫ অক্ষর)।');
        if (db.supportAgents.some(agent => agent.username.toLowerCase() === username.toLowerCase())) {
          clearState(uid); return bot.sendMessage(chatId, 'ℹ️ এই Support Agent আগে থেকেই যোগ করা আছে।', { reply_markup: adminKeyboard(uid) });
        }
        db.supportAgents.push({ username, name: displayName.slice(0, 50) });
        await saveDb(); clearState(uid);
        await bot.sendMessage(chatId, `✅ Support Agent যোগ হয়েছে: ${displayName} (@${username})`, { reply_markup: adminKeyboard(uid) });
        return showSupportAgentsAdmin(chatId);
      }
      if (state?.type === 'add_service') {
        const ids = text.split(/[,\s]+/).map(x => x.trim()).filter(Boolean), added = [];
        for (const serviceId of ids) if (/^\d+$/.test(serviceId) && !db.serviceIds.includes(serviceId)) { db.serviceIds.push(serviceId); added.push(serviceId); }
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, added.length ? `✅ Service ID যোগ হয়েছে:\n${added.join(', ')}` : '⚠️ নতুন কোনো ID যোগ হয়নি।', { reply_markup: adminKeyboard(chatId) });
      }
      if (state?.type === 'remove_service') {
        const ids = text.split(/[,\s]+/).map(x => x.trim()).filter(Boolean), before = db.serviceIds.length;
        db.serviceIds = db.serviceIds.filter(x => !ids.includes(x)); ids.forEach(x => delete db.prices[x]);
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, `✅ ${before - db.serviceIds.length}টি Service ID বাদ দেওয়া হয়েছে।`, { reply_markup: adminKeyboard(chatId) });
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
        return await bot.sendMessage(chatId, `✅ Service ${serviceId}-এর নতুন দাম/1K: ৳${money(db.prices[serviceId])}`, { reply_markup: adminKeyboard(chatId) });
      }
      if (state?.type === 'payment_method_set') {
        const number = text.trim();
        if (!/^[0-9+\-\s]{8,25}$/.test(number)) return await bot.sendMessage(chatId, '⚠️ সঠিক payment number দিন।');
        const method = state.method;
        if (state.paymentOwner === 'manager') {
          if (!isManager(uid)) { clearState(uid); return bot.sendMessage(chatId, '⛔ Manager permission নেই।'); }
          if (!db.managerPaymentMethods[String(uid)]) db.managerPaymentMethods[String(uid)] = { "বিকাশ": "", "নগদ": "", "বাইন্সাস": "" };
          db.managerPaymentMethods[String(uid)][method] = number;
        } else {
          if (!isOwner(uid)) { clearState(uid); return bot.sendMessage(chatId, '⛔ Admin permission নেই।'); }
          db.paymentMethods[method] = number;
          db.paymentNumbers = Object.values(db.paymentMethods).filter(Boolean);
        }
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, `✅ ${isOwner(uid) ? 'Admin' : 'Manager'} ${method} payment number সেট হয়েছে:\n${number}`, { reply_markup: adminKeyboard(chatId) });
      }
      if (state?.type === 'payment_change') {
        const number = text.trim();
        if (!/^[0-9+\-\s]{8,25}$/.test(number)) return await bot.sendMessage(chatId, '⚠️ সঠিক payment number দিন।');
        db.paymentNumbers = [number]; await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, `✅ Payment number পরিবর্তন হয়েছে:\n${number}`, { reply_markup: adminKeyboard(chatId) });
      }
      if (state?.type === 'payment_add') {
        const number = text.trim();
        if (!/^[0-9+\-\s]{8,25}$/.test(number)) return await bot.sendMessage(chatId, '⚠️ সঠিক payment number দিন।');
        if (!db.paymentNumbers.includes(number)) db.paymentNumbers.push(number);
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, `✅ Payment number যোগ হয়েছে:\n${number}`, { reply_markup: adminKeyboard(chatId) });
      }
      if (state?.type === 'payment_remove') {
        const number = text.trim(); db.paymentNumbers = db.paymentNumbers.filter(x => x !== number);
        await saveDb(); clearState(uid);
        return await bot.sendMessage(chatId, '✅ Payment number মুছে দেওয়া হয়েছে।', { reply_markup: adminKeyboard(chatId) });
      }
    }

    return await bot.sendMessage(chatId, localized(uid, `ℹ️ আমি পেয়েছি: ${text}\n\nনিচের মেনু থেকে একটি অপশন নির্বাচন করুন।`, `ℹ️ I received: ${text}\n\nChoose an option from the menu below.`), { reply_markup: customerKeyboard(uid) });
  } catch (e) {
    console.error('Message handler error:', e.stack || e.message);
    try { await bot.sendMessage(chatId, `❌ Bot error: ${e.message || 'Unknown error'}\n\nRender Logs দেখুন।`); } catch (_) {}
  }
});

bot.onText(/^\/addpayment$/i, async msg => {
  await rememberUser(msg); if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ অনুমতি নেই।");
  setState(msg.from.id, { type: "payment_add" }); return bot.sendMessage(msg.chat.id, "💳 নতুন payment number লিখুন।");
});
bot.onText(/^\/removepayment$/i, async msg => {
  await rememberUser(msg); if (!isOwner(msg.from.id)) return bot.sendMessage(msg.chat.id, "⛔ অনুমতি নেই।");
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
        // Check provider statuses every 60 seconds so customers see 'Completed' automatically.
        setInterval(() => { syncOrderStatuses().catch(err => console.error('Order status sync error:', err.message)); }, 60000);
        setTimeout(() => { syncOrderStatuses().catch(err => console.error('Initial order status sync error:', err.message)); }, 5000);
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
