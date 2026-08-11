import os
import asyncio
import requests
import threading
from flask import Flask
from telethon import TelegramClient, events, errors
from telethon.sessions import StringSession

# --- CONFIGURATION FROM ENVIRONMENT VARIABLES ---
API_ID = int(os.getenv("API_ID", "0"))
API_HASH = os.getenv("API_HASH", "")
BOT_TOKEN = os.getenv("BOT_TOKEN", "")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
RENDER_URL = os.getenv("RENDER_EXTERNAL_URL", "") # Render provides this automatically

# --- FLASK WEB SERVER (For Render Health Check & Keep-Alive) ---
app = Flask(__name__)

@app.route('/')
def home():
    return "Bot is running 24/7!"

def run_flask():
    port = int(os.getenv("PORT", 8080))
    app.run(host='0.0.0.0', port=port)

# --- SELF-PING SYSTEM (To prevent Render from sleeping) ---
async def keep_alive():
    if not RENDER_URL:
        print("RENDER_EXTERNAL_URL not set, self-ping disabled.")
        return
    
    while True:
        try:
            # Ping every 4 minutes (240 seconds)
            await asyncio.sleep(240)
            requests.get(RENDER_URL)
            print("Self-ping successful.")
        except Exception as e:
            print(f"Self-ping failed: {e}")

# --- TELEGRAM BOT LOGIC ---
bot = TelegramClient('bot_session', API_ID, API_HASH).start(bot_token=BOT_TOKEN)

# State management for interactive login
user_states = {}

@bot.on(events.NewMessage(pattern='/start'))
async def start(event):
    if event.sender_id != ADMIN_ID:
        return
    await event.respond("မင်္ဂလာပါ Admin! Session String ထုတ်ဖို့အတွက် /generate ကို နှိပ်ပါ။")

@bot.on(events.NewMessage(pattern='/generate'))
async def generate_session(event):
    if event.sender_id != ADMIN_ID:
        return
    
    user_states[event.sender_id] = {'step': 'phone'}
    await event.respond("Session ထုတ်မယ့် အကောင့်ရဲ့ ဖုန်းနံပါတ်ကို +95 ပုံစံဖြင့် ရိုက်ထည့်ပေးပါ။\n(ဥပမာ- +959123456789)")

@bot.on(events.NewMessage)
async def handle_steps(event):
    if event.sender_id != ADMIN_ID or event.sender_id not in user_states:
        return
    
    state = user_states[event.sender_id]
    text = event.text.strip()

    if state['step'] == 'phone':
        state['phone'] = text
        state['step'] = 'otp_request'
        
        # Start a temporary client for the user account
        temp_client = TelegramClient(StringSession(), API_ID, API_HASH)
        await temp_client.connect()
        
        try:
            sent_code = await temp_client.send_code_request(text)
            state['client'] = temp_client
            state['phone_code_hash'] = sent_code.phone_code_hash
            state['step'] = 'otp'
            await event.respond("Telegram မှ ပို့ပေးလိုက်သော Login Code (OTP) ကို ရိုက်ထည့်ပေးပါ။")
        except Exception as e:
            await event.respond(f"Error: {str(e)}\nပြန်စရန် /generate ကို နှိပ်ပါ။")
            await temp_client.disconnect()
            del user_states[event.sender_id]

    elif state['step'] == 'otp':
        temp_client = state['client']
        try:
            await temp_client.sign_in(state['phone'], text, phone_code_hash=state['phone_code_hash'])
            session_str = temp_client.session.save()
            await event.respond(f"✅ Success! သင်၏ Session String မှာ -\n\n`{session_str}`")
            await temp_client.disconnect()
            del user_states[event.sender_id]
        except errors.SessionPasswordNeededError:
            state['step'] = 'password'
            await event.respond("ဒီအကောင့်မှာ 2-Step Verification (Password) ရှိနေပါတယ်။ Password ကို ရိုက်ထည့်ပေးပါ။")
        except Exception as e:
            await event.respond(f"Error: {str(e)}\nပြန်စရန် /generate ကို နှိပ်ပါ။")
            await temp_client.disconnect()
            del user_states[event.sender_id]

    elif state['step'] == 'password':
        temp_client = state['client']
        try:
            await temp_client.sign_in(password=text)
            session_str = temp_client.session.save()
            await event.respond(f"✅ Success! သင်၏ Session String မှာ -\n\n`{session_str}`")
            await temp_client.disconnect()
            del user_states[event.sender_id]
        except Exception as e:
            await event.respond(f"Error: {str(e)}\nပြန်စရန် /generate ကို နှိပ်ပါ။")
            await temp_client.disconnect()
            del user_states[event.sender_id]

# --- MAIN EXECUTION ---
if __name__ == "__main__":
    # Start Flask in a background thread
    threading.Thread(target=run_flask, daemon=True).start()
    
    # Run the bot and the keep-alive loop
    loop = asyncio.get_event_loop()
    loop.create_task(keep_alive())
    print("Bot is starting...")
    bot.run_until_disconnected()
