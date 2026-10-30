import express from "express";
import crypto from "node:crypto";
import pg from "pg";
import { promisify } from "node:util";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const {
  GEMINI_API_KEY, SERPAPI_KEY, DATABASE_URL, AUTH_SECRET, CRON_KEY, BREVO_API_KEY, MAIL_FROM, MAX_CHECKS = "5",
    COUNTRY = "in", GEMINI_MODEL = "gemini-2.0-flash", DAILY_LIMIT = "30",
} = process.env;

const cache = new Map();   // query -> {t, data}
const hits = new Map();    // ip+day -> count
const TTL = 60 * 60 * 1000;

function overLimit(ip) {
  const k = ip + new Date().toISOString().slice(0, 10);
  if (hits.size > 5000) hits.clear();
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  return n > Number(DAILY_LIMIT);
}

const PROMPT = `Identify the main product in this photo so it can be searched in an online store.
Return JSON only: {"name": "brand + model if visible, otherwise a specific description", "category": "short category", "alternatives": ["2 or 3 related search queries for similar products"]}`;

async function identify(image, mime) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: image } }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (!r.ok) throw new Error(`Image recognition failed (${r.status}). Check GEMINI_API_KEY.`);
  const j = await r.json();
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const o = JSON.parse(text);
  return { name: o.name || "", category: o.category || "", alternatives: o.alternatives || [] };
}

function demoItems(q) {
  const stores = ["Amazon", "Flipkart", "Croma", "Reliance Digital", "Myntra", "Tata CLiQ", "Snapdeal", "Ajio"];
  let seed = [...q].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const base = 800 + Math.round(rnd() * 9000);
  return stores.map((s, i) => {
    const p = Math.round(base * (0.85 + rnd() * 0.4));
    return {
      title: `${q} (${s} listing ${i + 1})`, store: s, price: "₹" + p.toLocaleString("en-IN"),
      value: p, rating: +(3.6 + rnd() * 1.3).toFixed(1), reviews: Math.round(rnd() * 5000),
      link: "https://www.google.com/search?tbm=shop&q=" + encodeURIComponent(q), thumbnail: "",
    };
  });
}

async function shop(q, fresh = false) {
  const key = q.toLowerCase();
  const c = cache.get(key);
  if (!fresh && c && Date.now() - c.t < TTL) return c.data;
  let items;
  if (!SERPAPI_KEY) items = demoItems(q);
  else {
    const u = new URL("https://serpapi.com/search.json");
    u.search = new URLSearchParams({ engine: "google_shopping", q, gl: COUNTRY, hl: "en", api_key: SERPAPI_KEY });
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Price search failed (${r.status}). Check SERPAPI_KEY or quota.`);
    const j = await r.json();
    items = (j.shopping_results || []).map((x) => ({
      title: x.title, store: x.source || "Store", price: x.price, value: x.extracted_price,
      rating: x.rating || 0, reviews: x.reviews || 0,
      link: x.link || x.product_link || "", thumbnail: x.thumbnail || "",
    }));
  }
  items = items.filter((x) => typeof x.value === "number" && /^https?:/.test(x.link));
  if (items.length > 4) { // drop accessories / outliers far below the median price
    const m = items.map((x) => x.value).sort((a, b) => a - b)[Math.floor(items.length / 2)];
    items = items.filter((x) => x.value >= m * 0.3);
  }
  items.sort((a, b) => a.value - b.value);
  cache.set(key, { t: Date.now(), data: items });
  return items;
}

function recommend(items, skip) {
  if (!items.length) return [];
  const lo = items[0].value, hi = items[items.length - 1].value || lo;
  return items.filter((x) => x !== skip)
    .map((x) => ({
      ...x,
      score: (x.rating / 5) * 0.5 + Math.min(Math.log10(1 + x.reviews) / 4, 1) * 0.2 +
             (hi === lo ? 1 : 1 - (x.value - lo) / (hi - lo)) * 0.3,
    }))
    .sort((a, b) => b.score - a.score).slice(0, 4);
}

app.post("/api/analyze", async (req, res) => {
  try {
    if (overLimit(req.ip)) return res.status(429).json({ error: "Daily limit reached. Try again tomorrow." });
    const { image, mime = "image/jpeg", query } = req.body || {};
    let product = { name: (query || "").trim(), category: "", alternatives: [] };
    if (!product.name && !image) return res.status(400).json({ error: "Upload an image or type a product name." });
    if (!product.name) {
      product = GEMINI_API_KEY ? await identify(image, mime)
        : { name: "Wireless headphones", category: "Demo", alternatives: ["bluetooth speaker", "earbuds"] };
    }
    if (!product.name) return res.status(422).json({ error: "Could not recognise the product. Type its name instead." });
    const results = await shop(product.name);
    const best = results[0] || null;
    if (best && SERPAPI_KEY) recordPrice(product.name, best).catch(() => {});
    res.json({
      product, best, results: results.slice(0, 12), recommendations: recommend(results, best),
      demo: !SERPAPI_KEY || (!GEMINI_API_KEY && !query),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Something went wrong." });
  }
});

// ---------- Database, accounts, wishlist, price history, alerts ----------
const scrypt = promisify(crypto.scrypt);
const db = DATABASE_URL ? new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 }) : null;
const qkey = (s) => String(s || "").trim().toLowerCase().slice(0, 200);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const h = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: "Something went wrong." }); });

async function initDb() {
  if (!db) return console.log("No DATABASE_URL: accounts, wishlist and price history are disabled.");
  await db.query(`
    create table if not exists users(id serial primary key, email text unique not null, pass text not null, created_at timestamptz default now());
    create table if not exists wishlist(id serial primary key, user_id int references users(id) on delete cascade, query text not null, qkey text not null,
      title text, link text, store text, thumbnail text, price_text text, target_price double precision, last_price double precision,
      prev_price double precision, last_notified double precision, checked_at timestamptz, created_at timestamptz default now(), unique(user_id, qkey));
    create table if not exists price_history(id serial primary key, qkey text not null, price double precision not null, store text, ts timestamptz default now());
    create index if not exists ph_idx on price_history(qkey, ts);`);
}
initDb().catch((e) => console.error("DB init failed:", e.message));

const SECRET = AUTH_SECRET || crypto.randomBytes(32).toString("hex");
const hmac = (b) => crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
const sign = (p) => { const b = Buffer.from(JSON.stringify(p)).toString("base64url"); return b + "." + hmac(b); };
function verify(tok) {
  if (!tok) return null;
  const [b, sig] = tok.split(".");
  if (!b || !sig) return null;
  const ok = hmac(b);
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  try { const p = JSON.parse(Buffer.from(b, "base64url")); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const getCookie = (req, n) => (req.headers.cookie || "").split(";").map((s) => s.trim()).find((s) => s.startsWith(n + "="))?.slice(n.length + 1);
const setSession = (req, res, uid) =>
  res.cookie("pl", sign({ uid, exp: Date.now() + 30 * 864e5 }), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 30 * 864e5 });
async function hashPw(pw) { const salt = crypto.randomBytes(16); return salt.toString("hex") + ":" + (await scrypt(pw, salt, 64)).toString("hex"); }
async function checkPw(pw, stored) { const [s, x] = stored.split(":"); return crypto.timingSafeEqual(await scrypt(pw, Buffer.from(s, "hex"), 64), Buffer.from(x, "hex")); }
const needDb = (req, res, next) => (db ? next() : res.status(503).json({ error: "Accounts are not set up on this server yet." }));
const needUser = (req, res, next) => {
  const p = verify(getCookie(req, "pl"));
  if (!p) return res.status(401).json({ error: "Please sign in." });
  req.uid = p.uid; next();
};
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post("/api/auth/:mode(signup|login)", needDb, h(async (req, res) => {
  if (overLimit("auth" + req.ip)) return res.status(429).json({ error: "Too many attempts. Try again tomorrow." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const pw = String(req.body?.password || "");
  if (!emailRe.test(email) || email.length > 200) return res.status(400).json({ error: "Enter a valid email." });
  if (req.params.mode === "signup") {
    if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: "Password must be at least 8 characters." });
    try {
      const r = await db.query("insert into users(email, pass) values($1, $2) returning id", [email, await hashPw(pw)]);
      setSession(req, res, r.rows[0].id);
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "That email already has an account. Sign in instead." });
      throw e;
    }
  } else {
    const r = await db.query("select id, pass from users where email = $1", [email]);
    if (!r.rows[0] || !(await checkPw(pw, r.rows[0].pass))) return res.status(401).json({ error: "Wrong email or password." });
    setSession(req, res, r.rows[0].id);
  }
  res.json({ email });
}));
app.post("/api/auth/logout", (req, res) => { res.clearCookie("pl"); res.json({ ok: true }); });
app.get("/api/me", h(async (req, res) => {
  const p = verify(getCookie(req, "pl"));
  let email = null;
  if (p && db) email = (await db.query("select email from users where id = $1", [p.uid])).rows[0]?.email || null;
  res.json({ email, dbReady: !!db });
}));

app.get("/api/wishlist", needDb, needUser, h(async (req, res) => {
  const r = await db.query("select id, query, title, link, store, thumbnail, price_text, target_price, last_price, prev_price from wishlist where user_id = $1 order by created_at desc", [req.uid]);
  res.json({ items: r.rows });
}));
app.post("/api/wishlist", needDb, needUser, h(async (req, res) => {
  const b = req.body || {};
  const q = String(b.query || "").trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "Missing product." });
  const n = (await db.query("select count(*)::int n from wishlist where user_id = $1 and qkey <> $2", [req.uid, qkey(q)])).rows[0].n;
  if (n >= 20) return res.status(400).json({ error: "Wishlist is full (20 items). Remove one first." });
  const url = (u) => (/^https?:\/\//.test(u || "") ? u : null);
  const target = Number(b.targetPrice) > 0 ? Number(b.targetPrice) : null;
  await db.query(
    `insert into wishlist(user_id, query, qkey, title, link, store, thumbnail, price_text, target_price, last_price)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict(user_id, qkey) do update set target_price = excluded.target_price, title = excluded.title, link = excluded.link,
       store = excluded.store, thumbnail = excluded.thumbnail, price_text = excluded.price_text, last_price = excluded.last_price`,
    [req.uid, q, qkey(q), String(b.title || q).slice(0, 300), url(b.link), String(b.store || "").slice(0, 100), url(b.thumbnail),
     String(b.priceText || "").slice(0, 40), target, Number(b.price) || null]);
  res.json({ ok: true });
}));
app.delete("/api/wishlist/:id", needDb, needUser, h(async (req, res) => {
  await db.query("delete from wishlist where id = $1 and user_id = $2", [Number(req.params.id) || 0, req.uid]);
  res.json({ ok: true });
}));

async function recordPrice(name, best) {
  if (!db) return;
  await db.query(
    `insert into price_history(qkey, price, store)
     select $1::text, $2::double precision, $3::text
     where not exists (select 1 from price_history where qkey = $1::text and ts > now() - interval '30 minutes')`,
    [qkey(name), best.value, best.store]);
}
app.get("/api/history", needDb, h(async (req, res) => {
  const r = await db.query(
    `select extract(epoch from date_trunc('day', ts)) * 1000 as t, min(price) as p from price_history
     where qkey = $1 and ts > now() - interval '90 days' group by 1 order by 1`, [qkey(req.query.q)]);
  res.json({ points: r.rows.map((x) => ({ t: Number(x.t), p: x.p })) });
}));

async function sendMail(to, subject, html) {
  if (!BREVO_API_KEY || !MAIL_FROM) return console.log("[mail skipped, no BREVO_API_KEY/MAIL_FROM]", to, subject);
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST", headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ sender: { email: MAIL_FROM, name: "PriceLens" }, to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!r.ok) console.error("Email send failed", r.status);
}

// Call this URL on a schedule (see README): /api/cron?key=YOUR_CRON_KEY
app.get("/api/cron", needDb, h(async (req, res) => {
  if (!CRON_KEY || req.query.key !== CRON_KEY) return res.status(403).json({ error: "Forbidden" });
  if (!SERPAPI_KEY) return res.json({ checked: 0, note: "SERPAPI_KEY missing" });
  const qs = await db.query("select qkey, min(checked_at) c from wishlist group by qkey order by c asc nulls first limit $1", [Number(MAX_CHECKS) || 5]);
  let checked = 0, alerts = 0;
  for (const { qkey: k } of qs.rows) {
    const items = await shop(k, true).catch(() => []);
    const best = items[0];
    if (!best) continue;
    checked++;
    await recordPrice(k, best);
    const rows = (await db.query("select w.*, u.email from wishlist w join users u on u.id = w.user_id where w.qkey = $1", [k])).rows;
    for (const w of rows) {
      const old = w.last_price;
      const dropped = old != null && best.value < old;
      const below = w.target_price ? best.value <= w.target_price : old != null && best.value <= old * 0.97;
      const notify = below && (w.last_notified == null || best.value < w.last_notified);
      await db.query(
        "update wishlist set prev_price=$1, last_price=$2, price_text=$3, store=$4, link=$5, title=$6, thumbnail=$7, checked_at=now(), last_notified=$8 where id=$9",
        [dropped ? old : w.prev_price, best.value, best.price, best.store, best.link, best.title, best.thumbnail, notify ? best.value : w.last_notified, w.id]);
      if (notify) {
        alerts++;
        await sendMail(w.email, `Price drop: ${w.query} is now ${best.price}`,
          `<p>Good news. <b>${esc(w.query)}</b> is now <b>${esc(best.price)}</b> at ${esc(best.store)}.</p><p><a href="${esc(best.link)}">Open the offer</a></p>`);
      }
    }
  }
  res.json({ checked, alerts });
}));

app.get("/health", (_, res) => res.send("ok"));
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("PriceLens running on :" + port));
