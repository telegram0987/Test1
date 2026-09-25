# Trusted BAZAAR Telegram SMM Bot v7

## Required Render Environment Variables
- BOT_TOKEN
- SMM_API_KEY
- ADMIN_ID
- DATABASE_URL
- SMM_API_URL=https://my.smmsun.com/api/v2

Start command: `node bot.js`

## Order behavior
When a customer submits an order, the bot calls the provider's SMM API server-side using `SMM_API_KEY`. It does **not** redirect the customer to the provider website. A successful provider response returns a Provider Order ID.

After a successful provider submission, the bot now sends an immediate **NEW ORDER RECEIVED** notification to `ADMIN_ID` containing user, service, link, quantity, cost, status, provider order ID, and API endpoint.

If provider submission fails, the admin receives an **ORDER FAILED** notification and the customer's balance is not deducted.

## Important
Do not put your BOT_TOKEN or SMM_API_KEY in source code. Keep them only in Render Environment Variables.
