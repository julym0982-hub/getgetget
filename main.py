import os
import asyncio
import requests
import threading
from flask import Flask
from telethon import TelegramClient, events, errors
from telethon.sessions import StringSession

# --- CONFIGURATION ---
# Render Env ထဲမှာ API_ID နဲ့ API_HASH ကို သေချာပေါက် ထည့်ပေးရပါမယ်
API_ID = os.getenv("API_ID")
API_HASH = os.getenv("API_HASH")
BOT_TOKEN = os.getenv("BOT_TOKEN")
ADMIN_ID = os.getenv("ADMIN_ID")

# Admin ID ကို integer ပြောင်းခြင်း
if ADMIN_ID:
    ADMIN_ID = int(ADMIN_ID)

# --- FLASK WEB SERVER ---
app = Flask(__name__)

@app.route('/')
def home():
    return "Bot is running 24/7!"

def run_flask():
    port = int(os.getenv("PORT", 8080))
    app.run(host='0.0.0.0', port=port)

# --- SELF-PING SYSTEM ---
async def keep_alive():
    url = os.getenv("RENDER_EXTERNAL_URL")
    if not url:
        return
    
    while True:
        try:
            await asyncio.sleep(240)
            requests.get(url)
        except:
            pass

# --- TELEGRAM BOT ---
bot = TelegramClient('bot_session', int(API_ID) if API_ID else 0, API_HASH).start(bot_token=BOT_TOKEN)

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
    
    # Error checking for API credentials
    if not API_ID or not API_HASH:
        await event.respond("Error: API_ID သို့မဟုတ် API_HASH ကို Environment Variables မှာ မတွေ့ပါ။")
        return

    user_states[event.sender_id] = {'step': 'phone'}
    await event.respond("Session ထုတ်မယ့် အကောင့်ရဲ့ ဖုန်းနံပါတ်ကို +95 ပုံစံဖြင့် ရိုက်ထည့်ပေးပါ။")

@bot.on(events.NewMessage)
async def handle_steps(event):
    if event.sender_id != ADMIN_ID or event.sender_id not in user_states:
        return
    
    state = user_states[event.sender_id]
    text = event.text.strip()

    if text.startswith('/'): return # Ignore other commands

    if state['step'] == 'phone':
        state['phone'] = text
        state['step'] = 'otp_request'
        
        # New client for the user
        temp_client = TelegramClient(StringSession(), int(API_ID), API_HASH)
        await temp_client.connect()
        
        try:
            # အရေးကြီးချက်: phone number ကို ပို့ပေးခြင်း
            sent_code = await temp_client.send_code_request(text)
            state['client'] = temp_client
            state['phone_code_hash'] = sent_code.phone_code_hash
            state['step'] = 'otp'
            await event.respond("Telegram မှ ပို့ပေးလိုက်သော OTP Code ကို ရိုက်ထည့်ပေးပါ။")
        except Exception as e:
            await event.respond(f"Error: {str(e)}\nပြန်စရန် /generate ကို နှိပ်ပါ။")
            await temp_client.disconnect()
            del user_states[event.sender_id]

    elif state['step'] == 'otp':
        temp_client = state['client']
        try:
            await temp_client.sign_in(state['phone'], text, phone_code_hash=state['phone_code_hash'])
            session_str = temp_client.session.save()
            await event.respond(f"✅ Success! Session String:\n\n`{session_str}`")
            await temp_client.disconnect()
            del user_states[event.sender_id]
        except errors.SessionPasswordNeededError:
            state['step'] = 'password'
            await event.respond("2-Step Verification Password ကို ရိုက်ထည့်ပေးပါ။")
        except Exception as e:
            await event.respond(f"Error: {str(e)}\nပြန်စရန် /generate ကို နှိပ်ပါ။")
            await temp_client.disconnect()
            del user_states[event.sender_id]

    elif state['step'] == 'password':
        temp_client = state['client']
        try:
            await temp_client.sign_in(password=text)
            session_str = temp_client.session.save()
            await event.respond(f"✅ Success! Session String:\n\n`{session_str}`")
            await temp_client.disconnect()
            del user_states[event.sender_id]
        except Exception as e:
            await event.respond(f"Error: {str(e)}")
            await temp_client.disconnect()
            del user_states[event.sender_id]

if __name__ == "__main__":
    threading.Thread(target=run_flask, daemon=True).start()
    loop = asyncio.get_event_loop()
    loop.create_task(keep_alive())
    bot.run_until_disconnected()
