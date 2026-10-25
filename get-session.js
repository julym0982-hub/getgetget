// Session string ထုတ်ပေးတဲ့ script (Admin Panel ထဲက "Phone နဲ့ login" ကိုသုံးရင် ဒါမလိုပါ)
// Run: node get-session.js     (ပြင်ပ package မလို — Node built-in readline သုံးထား)
require("dotenv").config();
const readline = require("readline");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

(async () => {
  console.log("==============================================");
  console.log("  Telegram Session String Generator");
  console.log("==============================================\n");

  // bot.js နဲ့ တူတဲ့ API_ID / API_HASH ကို .env ကယူ (မရှိရင် မေး)
  const API_ID = parseInt(process.env.API_ID) || parseInt(await ask("API_ID: "));
  const API_HASH = process.env.API_HASH || (await ask("API_HASH: "));

  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5 });

  await client.start({
    phoneNumber: () => ask("📱 Phone (ဥပမာ +959xxxxxxxxx): "),
    password: () => ask("🔑 2FA password (မရှိရင် Enter): "),
    phoneCode: () => ask("📨 Telegram က ပို့တဲ့ OTP code: "),
    onError: (err) => console.error("Error:", err.message),
  });

  console.log("\n==============================================");
  console.log("✅ SESSION STRING ရပြီ! — Admin Panel > Accounts > ➕ ထည့် > Session string မှာ paste လုပ်ပါ");
  console.log("==============================================\n");
  console.log(client.session.save());
  console.log("\n==============================================\n");

  await client.disconnect();
  rl.close();
  process.exit(0);
})();
