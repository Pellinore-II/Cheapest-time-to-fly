/**
 * Cheapest Time to Fly — Backend Server
 * Always fetches one-way prices. Frontend calls twice for round trip.
 *
 * GET /api/prices?origin=MKE&dest=LAX&year=2026&month=4
 * GET /health
 */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3001;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

app.use(cors());

const cache     = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
  const e = cache.get(key);
  return e && Date.now() - e.fetchedAt < CACHE_TTL ? e.data : null;
}

async function fetchDate(origin, dest, dateStr) {
  const { data } = await axios.get('https://serpapi.com/search', {
    timeout: 10000,
    params: {
      engine: 'google_flights',
      departure_id: origin,
      arrival_id: dest,
      outbound_date: dateStr,
      currency: 'USD',
      hl: 'en',
      type: '2',
      api_key: SERPAPI_KEY,
    },
  });

  const all   = [...(data.best_flights || []), ...(data.other_flights || [])];
  const valid = all.filter(f => f.price > 0).sort((a, b) => a.price - b.price);
  if (!valid.length) return null;

  const best = valid[0];
  return {
    price:   best.price,
    airline: best.flights?.[0]?.airline || null,
  };
}

function getDays(year, month) {
  const days = [], d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    days.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`);
    d.setDate(d.getDate() + 1);
  }
  return days;
}

async function fetchMonth(origin, dest, year, month) {
  const key    = `${origin}-${dest}-${year}-${month}`;
  const cached = getCached(key);
  if (cached) return cached;

  const days   = getDays(year, month);
  const prices = {};

  for (let i = 0; i < days.length; i += 5) {
    await Promise.all(days.slice(i, i + 5).map(async date => {
      try   { prices[date] = await fetchDate(origin, dest, date); }
      catch { prices[date] = null; }
    }));
    if (i + 5 < days.length) await new Promise(r => setTimeout(r, 500));
  }

  const valid     = Object.entries(prices).filter(([, v]) => v !== null);
  const allP      = valid.map(([, v]) => v.price);
  const sorted    = [...valid].sort((a, b) => a[1].price - b[1].price);
  const avgPrice  = allP.length ? Math.round(allP.reduce((a,b)=>a+b)/allP.length) : null;
  const minPrice  = allP.length ? Math.min(...allP) : null;
  const maxPrice  = allP.length ? Math.max(...allP) : null;
  const cheapestDays = sorted.slice(0,3).map(([d])=>d);
  const priciest     = sorted.slice(-3).map(([d])=>d);

  const dow = {0:[],1:[],2:[],3:[],4:[],5:[],6:[]};
  valid.forEach(([ds,v]) => dow[new Date(ds).getDay()].push(v.price));
  const dowAverages = Object.fromEntries(
    Object.entries(dow).map(([d,arr]) => [d, arr.length ? Math.round(arr.reduce((a,b)=>a+b)/arr.length) : null])
  );

  const recommendation = minPrice && avgPrice && minPrice < avgPrice * 0.9 ? 'book_now' : 'wait';

  const data = { origin, dest, year, month, prices, dowAverages, cheapestDays, priciest, avgPrice, minPrice, maxPrice, recommendation };
  cache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

app.get('/api/prices', async (req, res) => {
  const { origin, dest, year, month } = req.query;
  if (!origin || !dest || !year || !month)
    return res.status(400).json({ ok: false, error: 'origin, dest, year, month required' });
  if (!SERPAPI_KEY)
    return res.status(500).json({ ok: false, error: 'SERPAPI_KEY not set' });
  try {
    const data = await fetchMonth(origin.toUpperCase(), dest.toUpperCase(), +year, +month);
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true, hasKey: !!SERPAPI_KEY }));
app.listen(PORT, () => console.log(`Running on :${PORT}`));
