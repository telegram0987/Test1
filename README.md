# Trusted BAZAAR Telegram SMM Bot

## Required Render Environment Variables
- BOT_TOKEN
- SMM_API_KEY
- ADMIN_ID
- DATABASE_URL
- SMM_API_URL=https://my.smmsun.com/api/v2

Start command: `node bot.js`

## IMPORTANT: Persistent data
Customer balances, deposits, orders, services, prices, payment numbers, users, and referral data are stored in PostgreSQL (`DATABASE_URL`). The bot now refuses to start if `DATABASE_URL` is missing, so a redeploy cannot silently start with empty temporary data.

Keep the **same PostgreSQL DATABASE_URL** across every deploy. Do not create a new database or replace the URL when redeploying.

The bot loads the saved database before accepting Telegram updates and preserves existing user/referral fields when a user sends a message.

## Order behavior
Orders are submitted server-side to the configured SMM API using `SMM_API_KEY`. The customer is not redirected to the provider website.

Do not put BOT_TOKEN or SMM_API_KEY in source code. Keep them in Render Environment Variables.

## Customer account & admin customer history
- Customer Panel → `👤 Account Details` shows User ID, username, name, current balance, total orders, total order value, completed order count, last seen, and joined time when available.
- Admin Panel → `👤 Customer Details` lists customers and lets the admin open an individual customer profile.
- Each customer profile includes order history with Order ID, service name/ID, quantity, cost, status, provider order ID, link, and order time.
- New orders also save the service name so future admin history is easier to read.

## Admin and manager access
- Set `ADMIN_ID` to the owner's numeric Telegram User ID. The owner opens the panel with `/admin` and sees `👥 Manage Managers`.
- Use `➕ Add Manager`, enter a manager's numeric Telegram User ID, and ask them to open `/admin`. They can get their ID with `/myid`.
- Managers can only set the bKash, Nagad, and Binance payment numbers and approve or reject payment requests. They cannot access service/pricing controls, customer history, or manager controls.
- Managers are stored in PostgreSQL with the bot settings, so the access list survives redeploys. Removing a manager takes effect immediately.
- Managers receive payment request notifications. Order details and order notifications remain visible to the owner only.
