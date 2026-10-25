require("dotenv").config();
const { Telegraf } = require("telegraf");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { Api } = require("telegram/tl");
const { MongoClient, ObjectId } = require("mongodb");
const http = require("http");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_ID    = parseInt(process.env.API_ID);
const API_HASH  = process.env.API_HASH;
const ADMIN_ID  = parseInt(process.env.ADMIN_ID);
const MONGO_URI = process.env.MONGO_URI;

for (const [k, v] of Object.entries({ BOT_TOKEN, API_ID, API_HASH, ADMIN_ID, MONGO_URI })) {
  if (!v) { console.error(`❌ Environment ထဲမှာ ${k} မရှိပါ (.env.example ကိုကြည့်ပါ)`); process.exit(1); }
}

// ─── STATE ────────────────────────────────────────────────────────────────────
let db;
let globalMsg        = "";
let intervalMinutes  = 60;   // scheduler interval (+ manual "safe send" cooldown)
let sendDelaySeconds = 6;    // GP တစ်ခုနဲ့တစ်ခုကြား delay
const JOIN_DELAY_SEC = 3;
let schedulerTimer   = null;
let nextRunAt        = 0;
let isSending        = false;
let isJoining        = false;
const clientPool     = {};   // name → TelegramClient
const entityCache    = {};   // `${name}|${link}` → entity
let awaiting         = null; // admin ဆီက စာသားစောင့်နေတဲ့ state
let draft            = null; // GP ထည့်ဖို့ ခဏသိမ်းထားတဲ့ links

const bot = new Telegraf(BOT_TOKEN);

// ─── MONGODB ──────────────────────────────────────────────────────────────────
async function connectDB() {
  const c = new MongoClient(MONGO_URI);
  await c.connect();
  db = c.db("gpbot");
  console.log("✅ MongoDB connected!");
}
const getSettings = async () => (await db.collection("settings").findOne({ _id: "main" })) || {};
const saveSettings = (data) => db.collection("settings").updateOne({ _id: "main" }, { $set: data }, { upsert: true });
const getAccounts = () => db.collection("accounts").find({}).sort({ order: 1, addedAt: 1 }).toArray();
const getAccount = (name) => db.collection("accounts").findOne({ name });
const getAccById = async (id) => (ObjectId.isValid(id) ? db.collection("accounts").findOne({ _id: new ObjectId(id) }) : null);
const saveAccount = (name, data) => db.collection("accounts").updateOne({ name }, { $set: data }, { upsert: true });
async function deleteAccount(name) {
  await db.collection("accounts").deleteOne({ name });
  await db.collection("sendlogs").deleteMany({ accName: name });
}
async function getLastSent(accName, gpLink) {
  const d = await db.collection("sendlogs").findOne({ accName, gpLink });
  return d?.sentAt || null;
}
const updateLastSent = (accName, gpLink) =>
  db.collection("sendlogs").updateOne(
    { accName, gpLink },
    { $set: { accName, gpLink, sentAt: new Date() } },
    { upsert: true }
  );

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const sleep = (sec) => new Promise((r) => setTimeout(r, sec * 1000));
const clip = (t, n = 3900) => (t.length > n ? t.slice(0, n - 20) + "\n…(ဆက်ရှိသေး)" : t);
const short = (s, n = 34) => (s.length > n ? s.slice(0, n) + "…" : s);
const btn = (text, data) => ({ text, callback_data: data });
const fmtMin = (m) => (m >= 60 ? (m % 60 === 0 ? `${m / 60} နာရီ` : `${(m / 60).toFixed(1)} နာရီ`) : `${m} မိနစ်`);

function parseDuration(s) {
  const t = s.trim().toLowerCase();
  let m = t.match(/^(\d+)\s*(hr|h)$/);
  if (m) return parseInt(m[1]) * 60;
  m = t.match(/^(\d+)\s*(min|m)?$/);
  if (m) return parseInt(m[1]);
  return 0;
}

// spin: "word1{spin}word2{spin}word3" → random pick
function pickSpun(template) {
  const parts = template.split("{spin}").map((s) => s.trim()).filter(Boolean);
  return parts[Math.floor(Math.random() * parts.length)] || template;
}

const notify = (text, extra) => bot.telegram.sendMessage(ADMIN_ID, clip(text), extra);
function runBg(fn) {
  // အကြာကြီးကြာတဲ့ အလုပ်တွေကို handler ထဲမှာ await မလုပ်ဘဲ background မှာ run
  setImmediate(() => fn().catch((e) => { console.error(e); notify(`❌ ${e.message}`).catch(() => {}); }));
}

function isAdmin(ctx) { return ctx.from?.id === ADMIN_ID; }
function adminOnly(ctx, next) { if (!isAdmin(ctx)) return; return next(); }

// ─── LINK PARSING ─────────────────────────────────────────────────────────────
function parseLink(raw) {
  const s = raw.trim();
  let m = s.match(/(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([\w-]+)/i);
  if (m) return { type: "invite", hash: m[1] };
  m = s.match(/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,})/i);
  if (m) return { type: "public", username: m[1] };
  return null;
}
function extractLinks(text) {
  const re = /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[^\s,;]+|@[A-Za-z][A-Za-z0-9_]{3,}/gi;
  const out = [];
  for (const m of text.match(re) || []) {
    let l = m.trim();
    if (l.startsWith("@")) l = "https://t.me/" + l.slice(1);
    else if (!/^https?:/i.test(l)) l = "https://" + l;
    if (parseLink(l) && !out.includes(l)) out.push(l);
  }
  return out;
}

// ─── GRAMJS ───────────────────────────────────────────────────────────────────
async function buildClient(sessionString) {
  const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5 });
  await client.connect();
  try {
    await client.getMe(); // session အသုံးဝင်မဝင် စစ်
  } catch (e) {
    try { await client.disconnect(); } catch (_) {}
    throw e;
  }
  return client;
}

async function initAllClients() {
  for (const acc of await getAccounts()) {
    if (clientPool[acc.name]) continue;
    try {
      clientPool[acc.name] = await buildClient(acc.sessionString);
      console.log(`✅ Connected: ${acc.name}`);
    } catch (e) {
      console.error(`❌ Failed: ${acc.name} — ${e.message}`);
    }
  }
}

async function reconnectAccount(acc) {
  if (clientPool[acc.name]) {
    try { await clientPool[acc.name].disconnect(); } catch (_) {}
    delete clientPool[acc.name];
  }
  clientPool[acc.name] = await buildClient(acc.sessionString);
}

async function joinGroup(client, link) {
  const p = parseLink(link);
  if (!p) throw new Error("Link format မှားနေသည်");
  if (p.type === "invite") {
    await client.invoke(new Api.messages.ImportChatInvite({ hash: p.hash }));
  } else {
    const entity = await client.getEntity(p.username);
    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
  }
}

async function resolveEntity(accName, client, link) {
  const key = `${accName}|${link}`;
  if (entityCache[key]) return entityCache[key];
  const p = parseLink(link);
  if (!p) throw new Error("Link format မှားနေသည်");
  let entity;
  if (p.type === "invite") {
    const r = await client.invoke(new Api.messages.CheckChatInvite({ hash: p.hash }));
    if (r.className === "ChatInviteAlready" || r.className === "ChatInvitePeek") entity = r.chat;
    else throw new Error("ဒီ account က GP ထဲ join မလုပ်ရသေးပါ (Join အရင်လုပ်ပါ)");
  } else {
    entity = await client.getEntity(p.username);
  }
  entityCache[key] = entity;
  return entity;
}

async function sendToGroup(accName, client, link, message) {
  const entity = await resolveEntity(accName, client, link);
  await client.sendMessage(entity, { message, parseMode: "html", linkPreview: false });
}

const isDeadSession = (e) => /AUTH_KEY|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(e.message || "");

// ─── PROGRESS (message တစ်ခုတည်းကို edit လုပ်ပြီး အခြေအနေပြ) ─────────────────
class Progress {
  constructor(title) { this.title = title; this.lines = []; this.msgId = null; this.last = 0; }
  text() { return clip(`${this.title}\n\n${this.lines.slice(-28).join("\n")}`); }
  async add(line, force = false) {
    this.lines.push(line);
    await this.flush(force);
  }
  async flush(force = false) {
    try {
      if (!this.msgId) {
        const m = await notify(this.text());
        this.msgId = m.message_id;
        this.last = Date.now();
      } else if (force || Date.now() - this.last > 2500) {
        await bot.telegram.editMessageText(ADMIN_ID, this.msgId, undefined, this.text());
        this.last = Date.now();
      }
    } catch (e) {
      if (!/not modified/i.test(e.message || "")) console.error("progress:", e.message);
    }
  }
}

// ─── CORE SEND ────────────────────────────────────────────────────────────────
// scheduler ကခေါ်ရင် force=true → rate limit နဲ့ interval တူနေလို့ GP တွေ skip မဖြစ်တော့ပါ
async function sendAllAccounts({ force = false, onlyName = null, source = "manual" } = {}) {
  if (isSending) { await notify("⚠️ ပို့နေဆဲ ရှိသေးသည်။ ခဏစောင့်ပါ။"); return; }
  isSending = true;
  const title = source === "scheduler" ? "⏰ Auto send (scheduler)" : force ? "⚡ Force send" : "📤 Send (cooldown စစ်)";
  const prog = new Progress(title);
  let ok = 0, fail = 0, skip = 0;
  try {
    const accounts = (await getAccounts()).filter((a) => !onlyName || a.name === onlyName);
    const active = accounts.filter((a) => clientPool[a.name]);
    if (!active.length) { await prog.add("⚠️ Connected account မရှိပါ"); return; }
    await prog.add(`👤 Active ${active.length} | ⏱ delay ${sendDelaySeconds}s`);

    for (const acc of active) {
      const client = clientPool[acc.name];
      const gpLinks = acc.gpLinks || [];
      const msg = acc.customMsg || globalMsg;
      if (!gpLinks.length) { await prog.add(`⏭ [${acc.name}] GP မရှိသေး`); continue; }
      if (!msg) { await prog.add(`⏭ [${acc.name}] Message မသတ်မှတ်ရသေး`); continue; }

      await prog.add(`▶️ [${acc.name}] GP ${gpLinks.length} ခု`);
      let aOk = 0, aFail = 0, aSkip = 0, attempted = false, minRem = 0;

      for (let i = 0; i < gpLinks.length; i++) {
        const link = gpLinks[i];
        if (!force) {
          const last = await getLastSent(acc.name, link);
          if (last) {
            const diff = (Date.now() - new Date(last).getTime()) / 60000;
            if (diff < intervalMinutes) {
              aSkip++;
              const rem = Math.ceil(intervalMinutes - diff);
              minRem = minRem ? Math.min(minRem, rem) : rem;
              continue;
            }
          }
        }
        if (attempted) await sleep(sendDelaySeconds);
        attempted = true;
        try {
          await sendToGroup(acc.name, client, link, pickSpun(msg));
          await updateLastSent(acc.name, link);
          aOk++;
          await prog.add(`✅ #${i + 1} [${acc.name}]`);
        } catch (err) {
          aFail++;
          await prog.add(`❌ #${i + 1} [${acc.name}] ${short(err.message || "error", 80)}`);
          if (isDeadSession(err)) {
            delete clientPool[acc.name];
            await prog.add(`🔴 [${acc.name}] session သက်တမ်းကုန်/ပိတ်ခံရ — Account ပြန်ထည့်ပါ`);
            break;
          }
          if (err.seconds) { // FLOOD_WAIT
            await prog.add(`⏳ Flood wait ${err.seconds}s — [${acc.name}] ဒီအကြိမ် ရပ်လိုက်သည်`);
            break;
          }
        }
      }
      ok += aOk; fail += aFail; skip += aSkip;
      await prog.add(`📊 [${acc.name}] ✅${aOk} ❌${aFail} ⏭${aSkip}${aSkip ? ` (နောက်ဆုံး ~${minRem}မိနစ်ကျန်)` : ""}`);
    }
    await prog.add(`\n🏁 ပြီးပါပြီ  ✅${ok}  ❌${fail}  ⏭${skip}`, true);
  } catch (e) {
    console.error(e);
    await prog.add(`❌ Error: ${e.message}`, true);
  } finally {
    isSending = false;
    await prog.flush(true);
  }
}

async function runJoin(accNames, links) {
  if (isJoining) { await notify("⚠️ Join လုပ်နေဆဲ ရှိသေးသည်"); return; }
  isJoining = true;
  const prog = new Progress("🤝 GP Join");
  try {
    await prog.add(`👤 ${accNames.join(", ")}\n🔗 GP ${links.length} ခု | ⏱ ${JOIN_DELAY_SEC}s delay`);
    for (const [ai, name] of accNames.entries()) {
      const client = clientPool[name];
      if (!client) { await prog.add(`❌ [${name}] connected မဟုတ်`); continue; }
      let ok = 0, fail = 0, already = 0;
      await prog.add(`▶️ [${name}]`);
      for (let i = 0; i < links.length; i++) {
        try {
          await joinGroup(client, links[i]);
          ok++;
          await prog.add(`✅ ${i + 1}. ${short(links[i], 40)}`);
        } catch (err) {
          const m = err.message || "";
          if (/USER_ALREADY_PARTICIPANT|already/i.test(m)) { already++; await prog.add(`ℹ️ ${i + 1}. ပါပြီးသား`); }
          else if (/INVITE_REQUEST_SENT/.test(m)) { ok++; await prog.add(`📨 ${i + 1}. Join request ပို့ပြီး (admin approve စောင့်)`); }
          else { fail++; await prog.add(`❌ ${i + 1}. ${short(m, 70)}`); }
          if (err.seconds) { await prog.add(`⏳ Flood wait ${err.seconds}s — ရပ်လိုက်သည်`); break; }
        }
        if (i < links.length - 1) await sleep(JOIN_DELAY_SEC);
      }
      await prog.add(`📊 [${name}] ✅${ok} ❌${fail} ℹ️${already}`);
      if (ai < accNames.length - 1) await sleep(JOIN_DELAY_SEC);
    }
    await prog.add("🏁 Join ပြီးပါပြီ", true);
  } finally {
    isJoining = false;
    await prog.flush(true);
  }
}

// ─── SCHEDULER ────────────────────────────────────────────────────────────────
function stopScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  nextRunAt = 0;
}
function startScheduler() {
  stopScheduler();
  if (intervalMinutes <= 0) return;
  const ms = intervalMinutes * 60 * 1000;
  nextRunAt = Date.now() + ms;
  schedulerTimer = setInterval(() => {
    nextRunAt = Date.now() + ms;
    if (isSending) { notify("⏰ Scheduler: ပို့နေဆဲမို့ ဒီအကြိမ် ကျော်လိုက်သည်").catch(() => {}); return; }
    sendAllAccounts({ force: true, source: "scheduler" }).catch((e) => console.error(e));
  }, ms);
  console.log(`⏰ Scheduler: every ${intervalMinutes} min`);
}
const nextRunText = () => {
  if (!schedulerTimer) return "";
  const mins = Math.max(0, Math.round((nextRunAt - Date.now()) / 60000));
  return ` (နောက်တစ်ကြိမ် ~${mins} မိနစ်အတွင်း)`;
};

// ═══════════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════════
async function render(ctx, text, rows) {
  const extra = { reply_markup: { inline_keyboard: rows || [] }, link_preview_options: { is_disabled: true } };
  const t = clip(text);
  if (ctx.callbackQuery) {
    try { return await ctx.editMessageText(t, extra); }
    catch (e) { if (/not modified/i.test(e.message || "")) return; }
  }
  return ctx.reply(t, extra);
}

const cancelRows = [[btn("❌ ပယ်ဖျက်", "cancel")]];

function waitInput(type, data = {}) {
  return new Promise((resolve, reject) => {
    cancelAwait("replaced");
    awaiting = { type, ...data, resolve, reject };
    const me = reject;
    setTimeout(() => { if (awaiting && awaiting.reject === me) cancelAwait("timeout"); }, 5 * 60 * 1000);
  });
}
function setAwait(type, data = {}) { cancelAwait("replaced"); awaiting = { type, ...data }; }
function cancelAwait(reason = "cancelled") {
  const a = awaiting;
  awaiting = null;
  if (a?.reject) a.reject(new Error(reason));
}

// ─── HOME ─────────────────────────────────────────────────────────────────────
async function showHome(ctx, note) {
  const accounts = await getAccounts();
  const connected = accounts.filter((a) => clientPool[a.name]).length;
  const sched = schedulerTimer ? `🟢 ${fmtMin(intervalMinutes)} တစ်ကြိမ်${nextRunText()}` : "🔴 ပိတ်ထား";
  let t = `🤖 GP Auto Sender — Admin Panel\n`;
  if (note) t += `\n${note}\n`;
  t += `\n👤 Accounts : ${accounts.length} ခု (🟢 ${connected} connected)`;
  t += `\n💬 Global msg: ${globalMsg ? "✅ သတ်မှတ်ပြီး" : "⚠️ မသတ်မှတ်ရသေး"}`;
  t += `\n⏰ Scheduler : ${sched}`;
  t += `\n⏱ Delay     : ${sendDelaySeconds}s (GP တစ်ခုချင်းကြား)`;
  if (isSending) t += `\n🔄 ပို့နေဆဲ...`;
  if (!accounts.length) t += `\n\n👉 စတင်ရန်: "👤 Accounts" → "➕ Account ထည့်"`;
  else t += `\n\n👇 လိုချင်တာကို နှိပ်ပါ`;
  return render(ctx, t, [
    [btn("👤 Accounts", "accs"), btn("💬 Global Message", "gmsg")],
    [btn("📤 ယခုပို့မယ်", "send"), btn("⏰ Scheduler", "sch")],
    [btn("🤝 GP Join", "join"), btn("⚙️ Settings", "set")],
    [btn("📊 Status", "stat"), btn("🔄 Refresh", "home")],
  ]);
}

// ─── ACCOUNTS ─────────────────────────────────────────────────────────────────
async function showAccounts(ctx, note) {
  const accounts = await getAccounts();
  let t = `👤 Accounts (${accounts.length})\n`;
  if (note) t += `\n${note}\n`;
  t += accounts.length ? `\n🟢 = ချိတ်ထား   🔴 = မချိတ်\nနှိပ်ပြီး စီမံပါ 👇` : `\n📭 Account မရှိသေးပါ`;
  const rows = accounts.map((a) => [
    btn(`${clientPool[a.name] ? "🟢" : "🔴"} ${a.name} · GP ${(a.gpLinks || []).length}${a.customMsg ? " · 💬" : ""}`, `a:${a._id}`),
  ]);
  rows.push([btn("➕ Account ထည့်", "add:new")]);
  rows.push([btn("🔑 Session String ထုတ်ရုံ", "add:export")]);
  rows.push([btn("🏠 Home", "home")]);
  return render(ctx, t, rows);
}

async function showAccount(ctx, acc, note) {
  acc = (await getAccById(String(acc._id))) || acc;
  const gps = acc.gpLinks || [];
  const on = !!clientPool[acc.name];
  let t = `👤 ${acc.name}\n${on ? "🟢 Connected" : "🔴 Disconnected (🔄 Reconnect နှိပ်ပါ)"}\n`;
  if (note) t += `\n${note}\n`;
  t += `\n💬 Message: ${acc.customMsg ? "custom (ဒီ account သီးသန့်)" : globalMsg ? "global သုံးနေ" : "⚠️ မသတ်မှတ်ရသေး"}`;
  t += `\n🔗 GP: ${gps.length} ခု`;
  for (let i = 0; i < gps.length && i < 40; i++) {
    const last = await getLastSent(acc.name, gps[i]);
    const rem = last ? Math.ceil(intervalMinutes - (Date.now() - new Date(last).getTime()) / 60000) : 0;
    t += `\n${i + 1}. ${rem > 0 ? `⏳${rem}မိနစ်` : "✅"} ${short(gps[i], 36)}`;
  }
  if (gps.length > 40) t += `\n…နောက်ထပ် ${gps.length - 40} ခု`;
  const id = String(acc._id);
  const rows = [
    [btn("➕ GP ထည့်", `a:${id}:gadd`), btn("📝 GP အစားထိုး", `a:${id}:gset`)],
    [btn("🗑 GP တစ်ခုဖျက်", `a:${id}:grm`), btn("🧹 GP အကုန်ဖျက်", `a:${id}:gclr`)],
    [btn("💬 Message သတ်မှတ်", `a:${id}:msg`)],
  ];
  if (acc.customMsg) rows.push([btn("👁 Message ကြည့်", `a:${id}:msgv`), btn("🧽 Message ဖျက်", `a:${id}:msgclr`)]);
  rows.push([btn("🤝 Join", `a:${id}:join`), btn("📤 ဒီ account ပို့", `a:${id}:send`)]);
  rows.push([btn("🔄 Reconnect", `a:${id}:rc`), btn("🔑 Session ကြည့်", `a:${id}:sess`)]);
  rows.push([btn("🗑 Account ဖျက်", `a:${id}:del`)]);
  rows.push([btn("⬅️ Accounts", "accs")]);
  return render(ctx, t, rows);
}

async function accRoute(ctx, [id, action, arg]) {
  const acc = await getAccById(id);
  if (!acc) return showAccounts(ctx, "❌ Account မတွေ့တော့ပါ");
  const back = [[btn("⬅️ Account သို့", `a:${id}`)]];

  switch (action) {
    case undefined:
      cancelAwait();
      return showAccount(ctx, acc);

    case "gadd":
      setAwait("gp_add", { accId: id });
      return render(ctx, `➕ [${acc.name}] GP link တွေ ပို့ပါ\n\n• တစ်ခုထက်ပိုရင် comma (,) သို့ စာကြောင်းခြားပြီး ပို့လို့ရ\n• ဥပမာ:\nhttps://t.me/+abcdef\nhttps://t.me/mygroup`, cancelRows);

    case "gset":
      setAwait("gp_set", { accId: id });
      return render(ctx, `📝 [${acc.name}] GP list ကို အသစ်နဲ့ အစားထိုးမယ်\n\nလက်ရှိ ${(acc.gpLinks || []).length} ခု ပျက်သွားမယ်။ link အသစ်တွေ ပို့ပါ 👇`, cancelRows);

    case "grm": {
      const gps = acc.gpLinks || [];
      if (!gps.length) return showAccount(ctx, acc, "📭 ဖျက်စရာ GP မရှိပါ");
      if (arg === undefined) {
        const rows = gps.slice(0, 40).map((g, i) => [btn(`🗑 ${i + 1}. ${short(g, 36)}`, `a:${id}:grm:${i}`)]);
        rows.push(back[0]);
        return render(ctx, `🗑 [${acc.name}] ဘယ် GP ကို ဖျက်မလဲ?`, rows);
      }
      const idx = parseInt(arg);
      if (idx >= 0 && idx < gps.length) {
        const removed = gps.splice(idx, 1)[0];
        await saveAccount(acc.name, { gpLinks: gps });
        return showAccount(ctx, { ...acc, gpLinks: gps }, `🗑 ဖျက်ပြီး: ${short(removed, 40)}`);
      }
      return showAccount(ctx, acc);
    }

    case "gclr":
      return render(ctx, `🧹 [${acc.name}] GP ${(acc.gpLinks || []).length} ခုလုံး ဖျက်မှာ သေချာလား?`, [
        [btn("✅ ဖျက်မယ်", `a:${id}:gclrok`), btn("⬅️ မဖျက်ဘူး", `a:${id}`)],
      ]);
    case "gclrok":
      await saveAccount(acc.name, { gpLinks: [] });
      return showAccount(ctx, acc, "🧹 GP အကုန်ဖျက်ပြီး");

    case "msg":
      setAwait("acc_msg", { accId: id });
      return render(ctx, `💬 [${acc.name}] သီးသန့် message ပို့ပါ\n(global message ထက် ဦးစားပေး)\n\n💡 Spin: မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို ညီကိုများ\n→ ပို့တိုင်း တစ်မျိုးစီ ပြောင်းပို့မယ်\n💡 HTML သုံးလို့ရ: <b>bold</b>  <a href="https://t.me/xxx">link</a>`, cancelRows);
    case "msgv":
      return render(ctx, `💬 [${acc.name}] Message:\n\n${acc.customMsg || "-"}`, back);
    case "msgclr":
      await saveAccount(acc.name, { customMsg: "" });
      return showAccount(ctx, acc, "🧽 Custom message ဖျက်ပြီး (global သုံးမယ်)");

    case "join":
      setAwait("join_links", { target: id });
      return render(ctx, `🤝 [${acc.name}] Join မယ့် GP link တွေ ပို့ပါ\n(comma သို့ စာကြောင်းခြား)`, cancelRows);

    case "send":
      runBg(() => sendAllAccounts({ force: false, onlyName: acc.name }));
      return render(ctx, `🚀 [${acc.name}] ပို့စတင်ပြီ — progress ကို အောက်မှာကြည့်ပါ`, [
        [btn("⚡ Force နဲ့ပို့ (cooldown မစစ်)", `a:${id}:fsend`)], back[0],
      ]);
    case "fsend":
      runBg(() => sendAllAccounts({ force: true, onlyName: acc.name }));
      return render(ctx, `⚡ [${acc.name}] Force send စတင်ပြီ`, back);

    case "sess":
      return ctx.reply(
        `🔑 [${acc.name}] Session String (backup/ရွှေ့ဖို့)\n\n<code>${acc.sessionString}</code>\n\n⚠️ ဒါက password လိုပဲ — copy ပြီးရင် ဒီ message ကို ဖျက်ပါ`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: back } }
      );

    case "rc":
      try {
        await reconnectAccount(acc);
        return showAccount(ctx, acc, "✅ ပြန်ချိတ်ပြီး");
      } catch (e) {
        return showAccount(ctx, acc, `❌ ပြန်မချိတ်နိုင်: ${e.message}\n(session သက်တမ်းကုန်ရင် Account ဖျက်ပြီး ပြန်ထည့်ပါ)`);
      }

    case "del":
      return render(ctx, `🗑 "${acc.name}" ကို ဖျက်မှာ သေချာလား?\n(GP list, send log အကုန်ပျက်မယ်)`, [
        [btn("✅ ဖျက်မယ်", `a:${id}:delok`), btn("⬅️ မဖျက်ဘူး", `a:${id}`)],
      ]);
    case "delok":
      if (clientPool[acc.name]) {
        try { await clientPool[acc.name].disconnect(); } catch (_) {}
        delete clientPool[acc.name];
      }
      await deleteAccount(acc.name);
      return showAccounts(ctx, `🗑 "${acc.name}" ဖျက်ပြီး`);
  }
}

// ─── ADD ACCOUNT ──────────────────────────────────────────────────────────────
async function saveNewAccount(name, client, sessionString) {
  let phone = "";
  try { phone = (await client.getMe()).phone || ""; } catch (_) {}
  clientPool[name] = client;
  const count = (await getAccounts()).length;
  await saveAccount(name, {
    name, sessionString, phone, active: true,
    gpLinks: [], customMsg: "", order: count, addedAt: new Date(),
  });
}

async function connectSession(name, sessionString) {
  try {
    await notify(`⏳ "${name}" ချိတ်နေသည်...`);
    const client = await buildClient(sessionString);
    await saveNewAccount(name, client, sessionString);
    const acc = await getAccount(name);
    await notify(`✅ "${name}" connected! 🎉\n\nအောက်က "➕ GP ထည့်" နဲ့ GP link တွေ ဆက်ထည့်ပါ`, {
      reply_markup: { inline_keyboard: [[btn("👤 Account ဖွင့်", `a:${acc._id}`)], [btn("🏠 Home", "home")]] },
    });
  } catch (e) {
    await notify(`❌ ချိတ်မရပါ: ${e.message}\n\nSession string မှန်မမှန် ပြန်စစ်ပါ`, { reply_markup: { inline_keyboard: [[btn("🏠 Home", "home")]] } });
  }
}

async function loginWithPhone(name, phone, exportOnly = false) {
  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });
  let attempts = 0;
  try {
    await client.connect();
    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => {
        await notify(
          `📨 Telegram က ${phone} ဆီ code ပို့ပြီ\n(Telegram app ထဲက "Telegram" chat ကိုကြည့်ပါ)\n\n⚠️ Code ကို dash ခြားပြီး ရိုက်ပါ — ဥပမာ 1-2-3-4-5\n(ဒီလိုမရိုက်ရင် Telegram က code ကို ပိတ်ပစ်တတ်သည်)`,
          { reply_markup: { inline_keyboard: cancelRows } }
        );
        return waitInput("login_code");
      },
      password: async () => {
        await notify(`🔑 2FA password ရှိတယ်ဆိုရင် ရိုက်ထည့်ပါ`, { reply_markup: { inline_keyboard: cancelRows } });
        return waitInput("login_pass");
      },
      onError: async (err) => {
        attempts++;
        const m = err.message || "";
        if (/cancelled|timeout|replaced/.test(m)) return true;
        await notify(`⚠️ ${m}`);
        return attempts >= 3 || /PHONE_NUMBER|API_ID|FLOOD/.test(m);
      },
    });
    const sessionString = client.session.save();
    if (exportOnly) {
      await notify(
        `✅ Session String ရပြီ 👇 (ဒီ account ကို bot ထဲ မသိမ်းထားပါ)\n\n<code>${sessionString}</code>\n\n⚠️ ဒါက password လိုပဲ အရေးကြီးတယ် — copy ပြီးရင် ဒီ message ကို ဖျက်ပါ`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[btn("🏠 Home", "home")]] } }
      );
      await client.disconnect();
      return;
    }
    await saveNewAccount(name, client, sessionString);
    const acc = await getAccount(name);
    await notify(`✅ "${name}" login အောင်မြင်! 🎉`, {
      reply_markup: { inline_keyboard: [[btn("👤 Account ဖွင့်", `a:${acc._id}`)], [btn("🏠 Home", "home")]] },
    });
  } catch (e) {
    try { await client.disconnect(); } catch (_) {}
    if (/cancelled|replaced/.test(e.message || "")) return;
    const m = /timeout/.test(e.message || "") ? "အချိန်ကုန်သွားပြီ" : e.message;
    await notify(`❌ Login မအောင်မြင်: ${m}`, { reply_markup: { inline_keyboard: [[btn("🔁 ပြန်စ", "add:new")], [btn("🏠 Home", "home")]] } });
  }
}

async function addRoute(ctx, [action]) {
  switch (action) {
    case "new":
      setAwait("add_name");
      return render(ctx, `➕ Account အသစ်\n\nနာမည်တစ်ခု ပေးပါ (ဥပမာ: မိဘ၊ acc1)\nစာသားနဲ့ ရိုက်ပို့ပါ 👇`, cancelRows);
    case "export":
      setAwait("add_phone", { name: "(session ထုတ်ရုံ)", exportOnly: true });
      return render(ctx, `🔑 Session String ထုတ်ရုံ\n\nဖုန်းနံပါတ် ပို့ပါ (ဥပမာ +959792310926)\nAccount ကို bot ထဲ သိမ်းမှာမဟုတ်ဘဲ string ကိုပဲ ပြပေးမယ်`, cancelRows);
    case "phone": {
      if (awaiting?.type !== "add_pick") return showAccounts(ctx);
      const name = awaiting.name;
      setAwait("add_phone", { name });
      return render(ctx, `📱 "${name}" ရဲ့ ဖုန်းနံပါတ် ပို့ပါ\ncountry code ပါအောင် — ဥပမာ +959792310926`, cancelRows);
    }
    case "str": {
      if (awaiting?.type !== "add_pick") return showAccounts(ctx);
      const name = awaiting.name;
      setAwait("add_session", { name });
      return render(ctx, `📋 "${name}" ရဲ့ session string ကို paste လုပ်ပို့ပါ\n(သို့) session string ပါတဲ့ .txt file ပို့ပါ`, cancelRows);
    }
  }
}

// ─── GLOBAL MESSAGE ───────────────────────────────────────────────────────────
async function showGlobalMsg(ctx, note) {
  let t = `💬 Global Message\n(account မှာ သီးသန့် msg မရှိရင် ဒါကိုသုံးမယ်)\n`;
  if (note) t += `\n${note}\n`;
  t += globalMsg ? `\n"${globalMsg}"` : `\n⚠️ မသတ်မှတ်ရသေး`;
  t += `\n\n💡 Spin: မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို\n→ ပို့တိုင်း တစ်မျိုးစီ ပြောင်းပို့`;
  const rows = [[btn("✏️ Message ပြောင်း", "gmsg:set")]];
  if (globalMsg) rows[0].push(btn("🧽 ဖျက်", "gmsg:clr"));
  rows.push([btn("🏠 Home", "home")]);
  return render(ctx, t, rows);
}

// ─── SEND MENU ────────────────────────────────────────────────────────────────
function showSendMenu(ctx) {
  return render(ctx,
`📤 ယခုပို့မယ်

📤 Safe send
  → GP တစ်ခုစီရဲ့ cooldown (${fmtMin(intervalMinutes)}) မပြည့်သေးရင် skip

⚡ Force send
  → cooldown မစစ်ဘဲ အကုန်ချက်ချင်းပို့`, [
    [btn("📤 Safe send", "send:safe"), btn("⚡ Force send", "send:force")],
    [btn("🏠 Home", "home")],
  ]);
}

// ─── SCHEDULER MENU ───────────────────────────────────────────────────────────
function showScheduler(ctx, note) {
  const on = !!schedulerTimer;
  let t = `⏰ Scheduler (auto ပို့)\n`;
  if (note) t += `\n${note}\n`;
  t += `\nအခြေအနေ: ${on ? "🟢 ဖွင့်ထား" : "🔴 ပိတ်ထား"}`;
  t += `\nကြားကာလ: ${fmtMin(intervalMinutes)} တစ်ကြိမ်${nextRunText()}`;
  t += `\n\n💡 Interval ကို အောက်က နှိပ်လိုက်တာနဲ့ ချက်ချင်း ဖွင့်ပေးမယ်`;
  t += `\n💡 Auto ပို့တာက cooldown မစစ်ဘဲ interval အတိုင်း အတိအကျ ပို့ပါတယ်`;
  return render(ctx, t, [
    [btn(on ? "🔴 ပိတ်မယ်" : "🟢 ဖွင့်မယ်", "sch:toggle")],
    [btn("15 မိနစ်", "sch:int:15"), btn("30 မိနစ်", "sch:int:30"), btn("1 နာရီ", "sch:int:60")],
    [btn("2 နာရီ", "sch:int:120"), btn("3 နာရီ", "sch:int:180"), btn("6 နာရီ", "sch:int:360")],
    [btn("✏️ ကိုယ်တိုင်ရိုက် (60min / 2hr)", "sch:intc")],
    [btn("🏠 Home", "home")],
  ]);
}

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
function showSettings(ctx, note) {
  let t = `⚙️ Settings\n`;
  if (note) t += `\n${note}\n`;
  t += `\n⏱ Send delay: ${sendDelaySeconds}s\n   (GP တစ်ခုချင်း ပို့တဲ့ကြား စောင့်ချိန်။ နည်းလွန်းရင် Telegram က limit ကန့်သတ်နိုင်)`;
  t += `\n⏰ Interval : ${fmtMin(intervalMinutes)} (Scheduler မှာ ပြောင်းပါ)`;
  return render(ctx, t, [
    [btn("3s", "set:dly:3"), btn("6s", "set:dly:6"), btn("10s", "set:dly:10"), btn("15s", "set:dly:15"), btn("30s", "set:dly:30")],
    [btn("✏️ Delay ကိုယ်တိုင်ရိုက်", "set:dlyc")],
    [btn("⏰ Scheduler သို့", "sch")],
    [btn("🏠 Home", "home")],
  ]);
}

// ─── STATUS ───────────────────────────────────────────────────────────────────
async function showStatus(ctx) {
  const accounts = await getAccounts();
  const connected = accounts.filter((a) => clientPool[a.name]).length;
  let t = `📊 Status\n\n👤 Accounts: ${accounts.length} (🟢${connected})`;
  t += `\n💬 Global msg: ${globalMsg ? `"${short(globalMsg, 30)}"` : "⚠️ မသတ်မှတ်ရသေး"}`;
  t += `\n⏰ Scheduler: ${schedulerTimer ? `🟢 ${fmtMin(intervalMinutes)}${nextRunText()}` : "🔴 ပိတ်"}`;
  t += `\n⏱ Delay: ${sendDelaySeconds}s | 🔄 ပို့နေဆဲ: ${isSending ? "ဟုတ်" : "မဟုတ်"}`;
  for (const acc of accounts) {
    const gps = acc.gpLinks || [];
    t += `\n\n━━━━━━━━━━━━\n${clientPool[acc.name] ? "🟢" : "🔴"} ${acc.name} · GP ${gps.length} · msg ${acc.customMsg ? "custom" : "global"}`;
    for (let i = 0; i < gps.length && i < 15; i++) {
      const last = await getLastSent(acc.name, gps[i]);
      const rem = last ? Math.ceil(intervalMinutes - (Date.now() - new Date(last).getTime()) / 60000) : 0;
      t += `\n ${i + 1}. ${rem > 0 ? `⏳${rem}မိနစ်` : "✅"} ${short(gps[i], 30)}`;
    }
    if (gps.length > 15) t += `\n …+${gps.length - 15} ခု`;
  }
  return render(ctx, t, [[btn("🔄 Refresh", "stat"), btn("🏠 Home", "home")]]);
}

// ─── JOIN MENU ────────────────────────────────────────────────────────────────
async function showJoin(ctx) {
  const accounts = (await getAccounts()).filter((a) => clientPool[a.name]);
  if (!accounts.length) return render(ctx, "❌ Connected account မရှိသေးပါ", [[btn("➕ Account ထည့်", "add:new")], [btn("🏠 Home", "home")]]);
  const rows = [[btn("👥 Account အကုန်နဲ့ Join", "join:all")]];
  for (const a of accounts) rows.push([btn(`👤 ${a.name} တစ်ခုတည်း`, `join:${a._id}`)]);
  rows.push([btn("🏠 Home", "home")]);
  return render(ctx, `🤝 GP Join\n\nဘယ် account နဲ့ Join မလဲ?\n\n💡 GP ထည့်တဲ့အချိန် "ထည့်ပြီး Join" ကိုလည်း သုံးလို့ရ`, rows);
}

// ─── GP DRAFT (ထည့်ရုံ / ထည့်ပြီး Join) ──────────────────────────────────────
async function applyDraft(joinToo) {
  if (!draft) throw new Error("ခဏသိမ်းထားတာ ပျက်သွားပြီ၊ ပြန်ထည့်ပါ");
  const acc = await getAccById(draft.accId);
  if (!acc) throw new Error("Account မတွေ့ပါ");
  let gps = acc.gpLinks || [];
  if (draft.mode === "set") gps = [...draft.links];
  else for (const l of draft.links) if (!gps.includes(l)) gps.push(l);
  await saveAccount(acc.name, { gpLinks: gps });
  const links = draft.links;
  draft = null;
  if (joinToo) {
    if (!clientPool[acc.name]) throw new Error(`"${acc.name}" connected မဟုတ်ပါ — GP ထည့်ပြီးပါပြီ၊ Join မလုပ်နိုင်`);
    runBg(() => runJoin([acc.name], links));
  }
  return { acc, count: gps.length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════
bot.start(adminOnly, (ctx) => { cancelAwait(); return showHome(ctx); });
bot.command(["panel", "menu"], adminOnly, (ctx) => { cancelAwait(); return showHome(ctx); });
bot.command("status", adminOnly, (ctx) => showStatus(ctx));
bot.command("send", adminOnly, (ctx) => { runBg(() => sendAllAccounts({ force: false })); return ctx.reply("📤 ပို့စတင်ပြီ..."); });
bot.command("cancel", adminOnly, (ctx) => { cancelAwait(); draft = null; return showHome(ctx, "❌ ပယ်ဖျက်ပြီး"); });

// ─── CALLBACKS ────────────────────────────────────────────────────────────────
bot.on("callback_query", adminOnly, async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  const p = (ctx.callbackQuery.data || "").split(":");
  try {
    await route(ctx, p);
  } catch (e) {
    console.error(e);
    await ctx.reply(`❌ ${e.message}`, { reply_markup: { inline_keyboard: [[btn("🏠 Home", "home")]] } }).catch(() => {});
  }
});

async function route(ctx, p) {
  const [k, a, b] = p;
  switch (k) {
    case "home": cancelAwait(); draft = null; return showHome(ctx);
    case "cancel": cancelAwait(); draft = null; return showHome(ctx, "❌ ပယ်ဖျက်ပြီး");
    case "accs": cancelAwait(); return showAccounts(ctx);
    case "a": return accRoute(ctx, p.slice(1));
    case "add": return addRoute(ctx, p.slice(1));

    case "gmsg":
      if (a === "set") {
        setAwait("global_msg");
        return render(ctx, `💬 Global message ပို့ပါ\n\n💡 Spin: မင်္ဂလာပါ{spin}ဟေး{spin}ဟယ်လို ညီကိုများ\n💡 HTML သုံးလို့ရ: <b>bold</b>  <a href="https://t.me/xxx">link</a>`, cancelRows);
      }
      if (a === "clr") { globalMsg = ""; await saveSettings({ globalMsg }); return showGlobalMsg(ctx, "🧽 ဖျက်ပြီး"); }
      return showGlobalMsg(ctx);

    case "send":
      if (a === "safe") { runBg(() => sendAllAccounts({ force: false })); return render(ctx, "🚀 Safe send စတင်ပြီ — progress ကို အောက်မှာကြည့်ပါ", [[btn("🏠 Home", "home")]]); }
      if (a === "force") { runBg(() => sendAllAccounts({ force: true })); return render(ctx, "⚡ Force send စတင်ပြီ — progress ကို အောက်မှာကြည့်ပါ", [[btn("🏠 Home", "home")]]); }
      return showSendMenu(ctx);

    case "sch":
      if (a === "toggle") {
        if (schedulerTimer) { stopScheduler(); await saveSettings({ schedulerOn: false }); return showScheduler(ctx, "⏹ ရပ်ပြီး"); }
        startScheduler(); await saveSettings({ schedulerOn: true });
        return showScheduler(ctx, "▶️ စတင်ပြီး");
      }
      if (a === "int") {
        const mins = parseInt(b);
        if (!mins) return showScheduler(ctx);
        intervalMinutes = mins;
        await saveSettings({ intervalMinutes, schedulerOn: true });
        startScheduler();
        return showScheduler(ctx, `✅ ${fmtMin(mins)} တစ်ကြိမ် သတ်မှတ်ပြီး ဖွင့်လိုက်ပြီ`);
      }
      if (a === "intc") {
        setAwait("int_custom");
        return render(ctx, `✏️ Interval ရိုက်ပို့ပါ\nဥပမာ: 45min  /  2hr  /  90`, cancelRows);
      }
      return showScheduler(ctx);

    case "set":
      if (a === "dly") {
        sendDelaySeconds = parseInt(b) || sendDelaySeconds;
        await saveSettings({ sendDelaySeconds });
        return showSettings(ctx, `✅ Delay ${sendDelaySeconds}s`);
      }
      if (a === "dlyc") { setAwait("dly_custom"); return render(ctx, "✏️ Delay စက္ကန့် ရိုက်ပို့ပါ (ဥပမာ 8)", cancelRows); }
      return showSettings(ctx);

    case "stat": return showStatus(ctx);

    case "join":
      if (!a) return showJoin(ctx);
      setAwait("join_links", { target: a });
      return render(ctx, `🤝 Join မယ့် GP link တွေ ပို့ပါ\n(comma သို့ စာကြောင်းခြား)`, cancelRows);

    case "gd": { // GP draft confirm
      const r = await applyDraft(a === "join");
      return showAccount(ctx, r.acc, `✅ GP ${r.count} ခု ရှိပြီ${a === "join" ? "\n🤝 Join စတင်ပြီ — progress အောက်မှာကြည့်ပါ" : ""}`);
    }
  }
}

// ─── TEXT INPUT ───────────────────────────────────────────────────────────────
bot.on("text", adminOnly, async (ctx) => {
  const raw = ctx.message.text.trim();
  if (raw.startsWith("/")) return showHome(ctx);
  if (!awaiting) return showHome(ctx, "👇 Button တွေနဲ့ပဲ အကုန်သုံးလို့ရပါတယ်");
  const a = awaiting;

  switch (a.type) {
    case "login_code":
    case "login_pass": {
      ctx.deleteMessage().catch(() => {}); // လုံခြုံရေးအတွက် ဖျက်
      awaiting = null;
      return a.resolve(a.type === "login_code" ? raw.replace(/\D/g, "") : raw);
    }

    case "add_name": {
      if (raw.length > 30) return ctx.reply("⚠️ နာမည် ရှည်လွန်းတယ် (၃၀ လုံးအောက်)");
      if (await getAccount(raw)) return ctx.reply(`⚠️ "${raw}" နာမည်ရှိပြီးသား၊ တခြားနာမည်ပေးပါ`);
      setAwait("add_pick", { name: raw });
      return ctx.reply(
        `👤 နာမည်: ${raw}\n\nဘယ်လိုထည့်မလဲ?\n\n📱 Phone + OTP — အလွယ်ဆုံး (get-session.js မလိုပါ)\n📋 Session string / .txt — ရှိပြီးသားဆိုရင်`,
        { reply_markup: { inline_keyboard: [[btn("📱 Phone နဲ့ login", "add:phone")], [btn("📋 Session string / file", "add:str")], [btn("❌ ပယ်ဖျက်", "cancel")]] } }
      );
    }
    case "add_pick":
      return ctx.reply("👆 အပေါ်က button တစ်ခုခု နှိပ်ပါ");

    case "add_phone": {
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 8) return ctx.reply("⚠️ ဖုန်းနံပါတ် မှန်မှန်ရိုက်ပါ (ဥပမာ +959792310926)");
      awaiting = null;
      const phone = "+" + digits;
      runBg(() => loginWithPhone(a.name, phone, !!a.exportOnly));
      return ctx.reply(`⏳ ${phone} ဆီ code ပို့ခိုင်းနေသည်...`);
    }

    case "add_session": {
      ctx.deleteMessage().catch(() => {});
      if (raw.length < 20) return ctx.reply("⚠️ Session string မှားနေပုံရတယ်၊ ပြန်ပို့ပါ");
      awaiting = null;
      runBg(() => connectSession(a.name, raw));
      return;
    }

    case "gp_add":
    case "gp_set": {
      const links = extractLinks(raw);
      if (!links.length) return ctx.reply("⚠️ GP link မတွေ့ပါ — https://t.me/... ပုံစံနဲ့ ပြန်ပို့ပါ");
      awaiting = null;
      draft = { accId: a.accId, links, mode: a.type === "gp_set" ? "set" : "add" };
      return ctx.reply(
        `🔗 GP ${links.length} ခု တွေ့တယ်:\n\n${links.map((l, i) => `${i + 1}. ${short(l, 45)}`).join("\n")}\n\n${draft.mode === "set" ? "အစားထိုးမယ်" : "ထည့်မယ်"} — Join ပါလုပ်မလား?`,
        { reply_markup: { inline_keyboard: [
          [btn("✅ ထည့်ရုံ", "gd:save")],
          [btn("🤝 ထည့်ပြီး Join ပါလုပ်", "gd:join")],
          [btn("❌ ပယ်ဖျက်", "cancel")],
        ] } }
      );
    }

    case "acc_msg": {
      const acc = await getAccById(a.accId);
      awaiting = null;
      if (!acc) return showAccounts(ctx, "❌ Account မတွေ့ပါ");
      await saveAccount(acc.name, { customMsg: raw });
      const spins = raw.split("{spin}").length;
      return showAccount(ctx, acc, `✅ Custom message သတ်မှတ်ပြီး${spins > 1 ? ` (Spin ${spins} မျိုး)` : ""}`);
    }

    case "global_msg": {
      awaiting = null;
      globalMsg = raw;
      await saveSettings({ globalMsg });
      const spins = raw.split("{spin}").length;
      return showGlobalMsg(ctx, `✅ သတ်မှတ်ပြီး${spins > 1 ? ` (Spin ${spins} မျိုး)` : ""}`);
    }

    case "join_links": {
      const links = extractLinks(raw);
      if (!links.length) return ctx.reply("⚠️ GP link မတွေ့ပါ — https://t.me/... ပုံစံနဲ့ ပြန်ပို့ပါ");
      awaiting = null;
      let names;
      if (a.target === "all") names = (await getAccounts()).filter((x) => clientPool[x.name]).map((x) => x.name);
      else {
        const acc = await getAccById(a.target);
        if (!acc || !clientPool[acc.name]) return showHome(ctx, "❌ Account connected မဟုတ်ပါ");
        names = [acc.name];
      }
      if (!names.length) return showHome(ctx, "❌ Connected account မရှိပါ");
      runBg(() => runJoin(names, links));
      return ctx.reply(`🚀 Join စတင်ပြီ (${names.length} account × ${links.length} GP)\nprogress ကို အောက်မှာ ကြည့်ပါ`, {
        reply_markup: { inline_keyboard: [[btn("🏠 Home", "home")]] },
      });
    }

    case "int_custom": {
      const mins = parseDuration(raw);
      if (!mins) return ctx.reply("⚠️ Format: 45min / 2hr / 90");
      awaiting = null;
      intervalMinutes = mins;
      await saveSettings({ intervalMinutes, schedulerOn: true });
      startScheduler();
      return showScheduler(ctx, `✅ ${fmtMin(mins)} တစ်ကြိမ် သတ်မှတ်ပြီး ဖွင့်လိုက်ပြီ`);
    }

    case "dly_custom": {
      const n = parseInt(raw);
      if (!n || n < 1) return ctx.reply("⚠️ နံပါတ်ရိုက်ပါ (ဥပမာ 8)");
      awaiting = null;
      sendDelaySeconds = n;
      await saveSettings({ sendDelaySeconds });
      return showSettings(ctx, `✅ Delay ${n}s`);
    }
  }
});

// ─── SESSION .txt FILE ────────────────────────────────────────────────────────
bot.on("document", adminOnly, async (ctx) => {
  if (awaiting?.type !== "add_session") return showHome(ctx, "⚠️ File လက်ခံဖို့ → Accounts → ➕ Account ထည့် → Session string / file ကို အရင်နှိပ်ပါ");
  const a = awaiting;
  try {
    const info = await ctx.telegram.getFile(ctx.message.document.file_id);
    const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${info.file_path}`);
    const sessionStr = (await res.text()).trim();
    if (!sessionStr || sessionStr.length < 20) return ctx.reply("❌ File ထဲက session string မှားနေသည်");
    awaiting = null;
    ctx.deleteMessage().catch(() => {});
    runBg(() => connectSession(a.name, sessionStr));
  } catch (err) {
    ctx.reply(`❌ Error: ${err.message}`);
  }
});

bot.catch((err) => console.error("Bot error:", err));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));

// ─── KEEP ALIVE ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end("GP Bot OK"); })
  .listen(PORT, () => console.log(`🌐 Port ${PORT}`));
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  http.get(url, (r) => { r.resume(); console.log(`💓 ${r.statusCode}`); }).on("error", () => {});
}, 14 * 60 * 1000);

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  await connectDB();

  const s = await getSettings();
  if (s.globalMsg)        globalMsg        = s.globalMsg;
  if (s.intervalMinutes)  intervalMinutes  = s.intervalMinutes;
  if (s.sendDelaySeconds) sendDelaySeconds = s.sendDelaySeconds;

  await initAllClients();
  if (s.schedulerOn && intervalMinutes > 0) startScheduler();

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });

  let launched = false, retry = 0;
  while (!launched) {
    try {
      // launch() က polling ကုန်ဆုံးမှ resolve ဖြစ်လို့ await မလုပ်ဘဲ error ကိုပဲ ဖမ်း
      await new Promise((resolve, reject) => {
        bot.launch({ dropPendingUpdates: true }, resolve).catch(reject);
        setTimeout(resolve, 8000);
      });
      launched = true;
      console.log("✅ Bot started!");
    } catch (err) {
      if (err.response?.error_code === 409) {
        retry++;
        console.log(`⚠️ 409 conflict — retry ${retry} in 5s...`);
        await sleep(5);
        await bot.telegram.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
      } else throw err;
    }
  }

  await notify("✅ GP Bot အသင့်ဖြစ်ပြီ!", { reply_markup: { inline_keyboard: [[btn("🏠 Panel ဖွင့်", "home")]] } }).catch(() => {});

  process.once("SIGINT",  () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((e) => { console.error(e); process.exit(1); });
