# PriceLens

Upload a product photo -> identified (Google Gemini) -> prices compared (SerpApi / Google Shopping) -> cheapest link, similar products, price history, wishlist and price-drop email alerts. Glass UI with a 3D animated background.

## Deploy free on Render
1. Create a GitHub repo and upload ALL files from this folder (keep `public/` as a folder).
2. Render: **New -> Web Service** -> connect the repo. Runtime **Node**, Build `npm install`, Start `npm start`, Instance **Free**.
3. Add environment variables (see `.env.example`):
   - `GEMINI_API_KEY` (free: https://aistudio.google.com/apikey)
   - `SERPAPI_KEY` (free tier: https://serpapi.com)
   - `COUNTRY` = `in` (or `us`, `uk`, ...)
4. Deploy and open your `onrender.com` URL. Without keys it runs in demo mode.

## Turn on accounts, wishlist and price history (all free)
Render's free disk is wiped on every restart, so data lives in a free external database.
1. Create a free Postgres database at https://neon.tech. Copy the connection string into `DATABASE_URL`. Tables are created automatically.
2. Add `AUTH_SECRET` and `CRON_KEY`: two long random strings (mash the keyboard for 40+ characters).
3. Redeploy. Sign in / Create account now works, and price history starts recording on each search.

## Turn on price-drop alerts
1. Free email: sign up at https://brevo.com, verify a sender address, create an API key. Set `BREVO_API_KEY` and `MAIL_FROM` (the verified address).
2. Free scheduler: at https://cron-job.org create a job that opens
   `https://YOUR-APP.onrender.com/api/cron?key=YOUR_CRON_KEY`
   once or twice a day. It also wakes the sleeping free server.
3. Each run re-checks up to `MAX_CHECKS` wishlist products (oldest first) and emails users when a product hits their target price, or drops 3%+ if no target was set.

## Quota warning
Every price check is one SerpApi search. The free plan is ~100 searches a month, shared with visitor searches. With `MAX_CHECKS=2` and one run a day you use about 60 a month. For more users, upgrade SerpApi or lower the check frequency.

## Run locally
```
npm install
GEMINI_API_KEY=... SERPAPI_KEY=... DATABASE_URL=... npm start
```
http://localhost:3000

## Not included: direct Amazon/Flipkart scraping
Scraping those sites breaks their terms, gets servers blocked within days, and tends to break whenever their pages change. Prices come from Google Shopping, which already lists Amazon, Flipkart and other stores. For official store feeds, use their affiliate APIs (Amazon Product Advertising API, Flipkart Affiliate API).
