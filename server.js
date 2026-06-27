require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');

const app = express();
app.use(express.json());
app.use(express.static(__dirname)); // serves admin.html at /admin.html

// ---- CORS ----
// Wide open for now so it's easy to test from any origin (file://, Live
// Server, different ports, etc). Before this goes live, lock it back down
// to your real frontend's origin(s) — see the commented block below.
app.use(cors());

/*
// Production version — only allow specific trusted origins:
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  }
}));
*/

// ---- Razorpay client ----
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error('Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env — copy .env.example to .env and fill these in.');
}
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---- In-memory "database" for this demo ----
// In production, replace these with your real database tables.
const orders = new Map(); // razorpay_order_id -> { amount, status, items, createdAt }

const colorHex = {
  Black:'#1C1A1D', White:'#F2EFE9', Red:'#C0392B', Blue:'#2E5C8A',
  Beige:'#C9B79C', Green:'#3C6E47', Pink:'#D9658A', Yellow:'#D4A017'
};

let nextProductId = 1;
const products = new Map(); // id -> product
const reviews = new Map(); // productId -> [{id, name, rating, comment, createdAt}]
let nextReviewId = 1;

function seedProducts(){
  const brands = ['Roadster','HRX','Vero Moda','Levis','Mast & Harbour','Anouk','U.S. Polo','Puma','W','Tokyo Talkies'];
  const productTypes = {
    Men:['Casual Shirt','Slim Fit Jeans','Bomber Jacket','Polo T-Shirt','Track Pants','Oxford Shoes'],
    Women:['Floral Maxi Dress','High-Rise Jeans','Crop Top','Ethnic Kurta Set','Trench Coat','Ballet Flats'],
    Kids:['Graphic Tee','Cargo Shorts','Party Frock','Hooded Sweatshirt'],
    Footwear:['Running Sneakers','Chelsea Boots','Sandals','Sports Slides'],
    Accessories:['Leather Belt','Canvas Tote Bag','Aviator Sunglasses','Analog Watch'],
    Beauty:['Matte Lipstick','Hydrating Serum','Perfume Spray','Kajal Pencil']
  };
  const colorList = Object.keys(colorHex);
  const randomFrom = arr => arr[Math.floor(Math.random()*arr.length)];

  Object.keys(productTypes).forEach(cat=>{
    productTypes[cat].forEach((type,i)=>{
      for(let v=0; v<3; v++){
        const mrp = Math.floor((800 + Math.random()*3200)/10)*10;
        const discountPct = [0,10,20,30,40,50][Math.floor(Math.random()*6)];
        const price = Math.round(mrp * (1-discountPct/100)/10)*10;
        const colorName = colorList[(i+v) % colorList.length];
        const id = nextProductId++;
        products.set(id, {
          id, category: cat, brand: randomFrom(brands), name: type, color: colorName,
          price, mrp, discountPct,
          gender: cat==='Men'?'Men':cat==='Women'?'Women':cat==='Kids'?'Kids':randomFrom(['Men','Women']),
          sizes: cat==='Footwear' ? ['6','7','8','9','10'] : ['XS','S','M','L','XL'],
          bg: colorHex[colorName],
          media: [] // [{type:'image'|'video', url}] — populated by admin
        });
        reviews.set(id, []);
      }
    });
  });
}
seedProducts();

/**
 * Returns a product with computed average rating + review count attached,
 * so the frontend never has to compute this itself.
 */
function withRatingInfo(product){
  const productReviews = reviews.get(product.id) || [];
  const avg = productReviews.length
    ? productReviews.reduce((s,r)=>s+r.rating,0) / productReviews.length
    : null;
  return {
    ...product,
    avgRating: avg !== null ? Math.round(avg*10)/10 : null,
    reviewCount: productReviews.length
  };
}

/**
 * Create a Razorpay order.
 * The frontend sends the cart; the server recalculates the price itself
 * (never trust an amount the browser sends) and creates the order with that.
 */
app.post('/api/create-order', async (req, res) => {
  try {
    const { items } = req.body; // [{ productId, price, qty }]
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    // Recompute the total server-side from our own product store — never
    // trust a price the browser sends, since editing JS in devtools could
    // otherwise let someone pay whatever they want.
    let amountInRupees = 0;
    for (const item of items) {
      const product = products.get(Number(item.productId));
      if (!product) {
        return res.status(400).json({ error: `Unknown product: ${item.productId}` });
      }
      const qty = Number(item.qty) || 0;
      amountInRupees += product.price * qty;
    }

    if (amountInRupees <= 0) {
      return res.status(400).json({ error: 'Invalid order amount.' });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amountInRupees * 100), // paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      notes: { source: 'vastra-demo-storefront' },
    });

    orders.set(order.id, {
      amount: amountInRupees,
      status: 'created',
      items,
      createdAt: new Date().toISOString(),
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID, // public key id — safe to expose
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'Could not create order.' });
  }
});

/**
 * Verify a payment after Razorpay's checkout popup completes.
 * This is the step that actually proves the payment is real — never trust
 * "payment succeeded" purely because the browser says so.
 */
app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ verified: false, error: 'Missing fields.' });
  }

  const order = orders.get(razorpay_order_id);
  if (!order) {
    return res.status(404).json({ verified: false, error: 'Unknown order.' });
  }

  const body = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  const isValid = expectedSignature === razorpay_signature;

  if (isValid) {
    order.status = 'paid';
    order.paymentId = razorpay_payment_id;
    orders.set(razorpay_order_id, order);
    return res.json({ verified: true, amount: order.amount });
  }

  order.status = 'verification_failed';
  orders.set(razorpay_order_id, order);
  return res.status(400).json({ verified: false, error: 'Signature mismatch — payment could not be verified.' });
});

/**
 * Optional: Razorpay webhook endpoint. Webhooks are the most reliable way to
 * know a payment succeeded (they fire even if the user closes the browser
 * right after paying). Set this URL in your Razorpay Dashboard → Webhooks,
 * and put the webhook secret in RAZORPAY_WEBHOOK_SECRET in .env if you use it.
 */
app.post('/api/webhook', express.json({ type: '*/*' }), (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return res.status(501).json({ error: 'Webhook secret not configured.' });
  }
  const signature = req.headers['x-razorpay-signature'];
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  if (signature !== expected) {
    return res.status(400).json({ error: 'Invalid webhook signature.' });
  }

  // Handle event types you care about, e.g. payment.captured
  console.log('Verified webhook event:', req.body.event);
  res.json({ received: true });
});

// ---- Admin auth ----
// Simple shared-secret auth for the admin dashboard. Not bank-grade, but
// enough to keep the order list from being public. Swap for real auth
// (sessions, JWT, your team's login system) before this goes live.
function requireAdmin(req, res, next){
  const key = req.headers['x-admin-key'];
  if(!process.env.ADMIN_API_KEY){
    return res.status(500).json({ error: 'ADMIN_API_KEY not configured on server.' });
  }
  if(key !== process.env.ADMIN_API_KEY){
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  next();
}

/**
 * List all orders, newest first. Used by the admin dashboard.
 */
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const list = Array.from(orders.entries())
    .map(([orderId, o]) => ({ orderId, ...o }))
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ orders: list });
});

/**
 * Single order detail.
 */
app.get('/api/admin/orders/:orderId', requireAdmin, (req, res) => {
  const order = orders.get(req.params.orderId);
  if(!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ orderId: req.params.orderId, ...order });
});

// ---- Products ----

/**
 * Public: list all products. The storefront loads its catalog from here.
 */
app.get('/api/products', (req, res) => {
  res.json({ products: Array.from(products.values()).map(withRatingInfo) });
});

/**
 * Public: single product with its reviews attached. The product modal
 * fetches this to show media, rating, and the review list.
 */
app.get('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const product = products.get(id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  res.json({
    product: withRatingInfo(product),
    reviews: (reviews.get(id) || []).slice().sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt))
  });
});

/**
 * Public: submit a review + rating for a product. No login required for
 * this demo — in a real store you'd tie this to a logged-in, verified buyer.
 */
app.post('/api/products/:id/reviews', (req, res) => {
  const id = Number(req.params.id);
  const product = products.get(id);
  if (!product) return res.status(404).json({ error: 'Product not found.' });

  const { name, rating, comment } = req.body;
  const ratingNum = Number(rating);
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
  }

  const review = {
    id: nextReviewId++,
    name: name.trim().slice(0, 60),
    rating: ratingNum,
    comment: (comment || '').trim().slice(0, 500),
    createdAt: new Date().toISOString()
  };
  const list = reviews.get(id) || [];
  list.push(review);
  reviews.set(id, list);

  res.status(201).json({ review, product: withRatingInfo(product) });
});

/**
 * Validates and cleans up a media array coming from the admin form.
 * Expects [{type:'image'|'video', url:'https://...'}, ...]
 */
function sanitizeMedia(media){
  if (!Array.isArray(media)) return [];
  return media
    .filter(m => m && typeof m.url === 'string' && m.url.trim())
    .map(m => ({
      type: m.type === 'video' ? 'video' : 'image',
      url: m.url.trim()
    }))
    .slice(0, 12); // cap so one product can't have an unbounded gallery
}

/**
 * Admin: create a new product.
 */
app.post('/api/admin/products', requireAdmin, (req, res) => {
  const { category, brand, name, color, price, mrp, gender, sizes, media } = req.body;

  if (!category || !brand || !name || price == null) {
    return res.status(400).json({ error: 'category, brand, name and price are required.' });
  }

  const priceNum = Number(price);
  const mrpNum = mrp != null ? Number(mrp) : priceNum;
  if (isNaN(priceNum) || priceNum <= 0) {
    return res.status(400).json({ error: 'price must be a positive number.' });
  }
  const discountPct = mrpNum > priceNum ? Math.round((1 - priceNum / mrpNum) * 100) : 0;

  const id = nextProductId++;
  const colorName = color && colorHex[color] ? color : 'Black';
  const product = {
    id,
    category,
    brand,
    name,
    color: colorName,
    price: priceNum,
    mrp: mrpNum,
    discountPct,
    gender: gender || 'Men',
    sizes: Array.isArray(sizes) && sizes.length ? sizes : ['S','M','L','XL'],
    bg: colorHex[colorName],
    media: sanitizeMedia(media)
  };
  products.set(id, product);
  reviews.set(id, []);
  res.status(201).json({ product: withRatingInfo(product) });
});

/**
 * Admin: update an existing product. Send only the fields you want to change.
 */
app.put('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = products.get(id);
  if (!existing) return res.status(404).json({ error: 'Product not found.' });

  const updates = req.body;
  const updated = { ...existing };

  ['category','brand','name','gender'].forEach(field=>{
    if (updates[field] !== undefined) updated[field] = updates[field];
  });
  if (updates.color !== undefined && colorHex[updates.color]) {
    updated.color = updates.color;
    updated.bg = colorHex[updates.color];
  }
  if (updates.price !== undefined) {
    const p = Number(updates.price);
    if (isNaN(p) || p <= 0) return res.status(400).json({ error: 'price must be a positive number.' });
    updated.price = p;
  }
  if (updates.mrp !== undefined) {
    updated.mrp = Number(updates.mrp);
  }
  if (updated.mrp > updated.price) {
    updated.discountPct = Math.round((1 - updated.price / updated.mrp) * 100);
  } else {
    updated.discountPct = 0;
    updated.mrp = updated.price;
  }
  if (updates.media !== undefined) {
    updated.media = sanitizeMedia(updates.media);
  }
  if (updates.sizes !== undefined && Array.isArray(updates.sizes)) {
    updated.sizes = updates.sizes;
  }

  products.set(id, updated);
  res.json({ product: withRatingInfo(updated) });
});

/**
 * Admin: delete a product.
 */
app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!products.has(id)) return res.status(404).json({ error: 'Product not found.' });
  products.delete(id);
  reviews.delete(id);
  res.json({ deleted: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

const path = require('path');

// Default route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'vastra-ecommerce-clone.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`VASTRA backend running on http://localhost:${PORT}`);
});
