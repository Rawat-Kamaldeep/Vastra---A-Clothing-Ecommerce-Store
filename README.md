# VASTRA Backend

A minimal Express server that does the two things a browser can never safely do on its own:

1. **Create a Razorpay order** using your secret key (server-side only)
2. **Verify the payment signature** after checkout, so you know a payment is real before marking an order as paid

## Setup

```bash
cd vastra-backend
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` — from your [Razorpay Dashboard → Settings → API Keys](https://dashboard.razorpay.com/app/keys). Use the **Test Mode** keys while developing.
- `ALLOWED_ORIGINS` — the URL(s) your frontend is served from (e.g. `http://localhost:5500` if you're opening `index.html` with VS Code's Live Server, or wherever you deploy it).

Then run it:

```bash
npm start
```

You should see `VASTRA backend running on http://localhost:4000`.

## Endpoints

| Method | Path                       | What it does                                          |
|--------|-----------------------------|--------------------------------------------------------|
| GET    | `/api/products`             | Public — the storefront loads its catalog from here    |
| GET    | `/api/products/:id`         | Public — single product with its media + reviews + live average rating |
| POST   | `/api/products/:id/reviews` | Public — submit a name + 1–5 star rating + optional comment |
| POST   | `/api/create-order`         | Takes cart items, recalculates the total, creates a Razorpay order |
| POST   | `/api/verify-payment`       | Verifies the signature Razorpay sends back after checkout |
| POST   | `/api/webhook`              | (Optional) Receives Razorpay webhook events            |
| GET    | `/api/admin/orders`         | Lists all orders (requires `x-admin-key` header)       |
| GET    | `/api/admin/orders/:id`     | Single order detail (requires `x-admin-key` header)    |
| POST   | `/api/admin/products`       | Create a product, optionally with a `media` array (requires `x-admin-key` header) |
| PUT    | `/api/admin/products/:id`   | Update a product — send only the fields you're changing (requires `x-admin-key` header) |
| DELETE | `/api/admin/products/:id`   | Delete a product, also clears its reviews (requires `x-admin-key` header) |
| GET    | `/api/health`               | Health check                                            |

## Admin dashboard

Open `http://localhost:4000/admin.html` once the server is running, and log in with your `ADMIN_API_KEY`. Two tabs:

- **Orders** — total count, revenue, and a table of every order with status (`created` / `paid` / `verification_failed`).
- **Products** — a form to add a new product (brand, name, category, gender, price, MRP, color, sizes), plus an **Image / Video URLs** box where you paste one direct link per line. `.mp4`/`.webm`/`.mov`/`.ogg` links are auto-detected as videos; everything else is treated as an image. Below the form, a table of every existing product shows its live rating and how many media files it has, with **Edit** and **Delete** on each row.

This media field stores **URLs**, not uploaded files — there's no file-upload storage wired up yet. So images/videos need to already be hosted somewhere (e.g. uploaded to a free image host, your own CDN, or a Google Drive/Imgur link that resolves to a direct file URL). If you want real file uploads from the admin panel instead of pasting links, that's a good next step (e.g. using `multer` to accept uploads and save them to disk or S3).

## Reviews

Each product page on the storefront shows its live average rating and lets any shopper submit a name, a 1–5 star rating, and an optional comment — no login required in this demo. The average updates immediately after a new review comes in. In a real store you'd likely tie reviews to a logged-in, verified buyer instead of an open name field.

This uses a simple shared-secret header check, not a real login system — fine for one person managing a demo project, but swap it for proper auth (sessions, a login page, your own user table) before anyone but you needs access.

## Connecting the frontend

In `index.html`, the `API_BASE_URL` constant near the top of the `<script>` tag should point at wherever this server runs — `http://localhost:4000` while testing locally, or your deployed backend URL in production.

## Going to production

- Swap the in-memory `orders` Map for a real database (Postgres, MongoDB, whatever you're comfortable with).
- Look up each product's price from your own product database in `/api/create-order` instead of trusting the price the browser sends — this demo trusts it only because there's no product DB on the server yet.
- Switch your Razorpay keys from Test Mode to Live Mode once you're ready to accept real payments.
- Set up the webhook in your Razorpay Dashboard pointing at `/api/webhook` and fill in `RAZORPAY_WEBHOOK_SECRET` — webhooks are the most reliable signal that a payment went through, since they fire even if the customer closes their browser right after paying.
- Deploy this somewhere with HTTPS (Render, Railway, Fly.io, a VPS, etc.) — Razorpay's checkout requires a secure context in production.
