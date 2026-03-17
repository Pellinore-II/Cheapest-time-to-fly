/**
 * Cheapest Time to Fly — Backend Server
 * Fetches Google Flights price data via SerpApi
 * 
 * Run: node server.js
 * Endpoint: http://localhost:3001/api/prices
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;
const SERPAPI_KEY = process.env.SERPAPI_KEY;

app.use(cors());
app.use(express.json());

// Simple in-memory cache: key = "origin-dest-year-month", value = { data, fetchedAt }
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function cacheKey(origin, dest, year, month) {
  return `${origin}-${dest}-${year}-${month}`;
}

function isCached(key) {
  const entry = cache.get(key);
  return entry && (Date.now() - entry.fetchedAt) < CACHE_TTL_MS;
}

/**
 * Fetch price for a single date from SerpApi Google Flights
 */
async function fetchPriceForDate(origin, dest, dateStr) {
  const params = {
    engine: 'google_flights',
    departure_id: origin,
    arrival_id: dest,
    outbound_date: dateStr,
    currency: 'USD',
    hl: 'en',
    type: '2', // one-way
    api_key: SERPAPI_KEY,
  };

  const response = await axios.get('https://serpapi.com/search', { params, timeout: 10000 });
  const data = response.data;

  // Pull the best price from best_flights or other_flights
  const allFlights = [
    ...(data.best_flights || []),
    ...(data.other_flights || []),
  ];

  if (allFlights.length === 0) return null;

  const prices = allFlights
    .map(f => f.price)
    .filter(p => typeof p === 'number' && p > 0);

  if (prices.length === 0) return null;

  return Math.min(...prices);
}

/**
 * Get all days in a given month
 */
function getDaysInMonth(year, month) {
  const days = [];
  const date = new Date(year, month - 1, 1);
  while (date.getMonth() === month - 1) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    days.push(`${y}-${m}-${d}`);
    date.setDate(date.getDate() + 1);
  }
  return days;
}

/**
 * Fetch prices for all days in a month (batched to avoid rate limits)
 */
async function fetchMonthPrices(origin, dest, year, month) {
  const key = cacheKey(origin, dest, year, month);
  if (isCached(key)) {
    return cache.get(key).data;
  }

  const days = getDaysInMonth(year, month);
  const results = {};

  // Batch requests: 5 at a time to avoid hammering SerpApi
  const batchSize = 5;
  for (let i = 0; i < days.length; i += batchSize) {
    const batch = days.slice(i, i + batchSize);
    await Promise.all(batch.map(async (dateStr) => {
      try {
        const price = await fetchPriceForDate(origin, dest, dateStr);
        results[dateStr] = price;
      } catch (err) {
        console.warn(`Failed ${dateStr}:`, err.message);
        results[dateStr] = null;
      }
    }));
    // Small delay between batches
    if (i + batchSize < days.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Compute day-of-week averages
  const dowTotals = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  Object.entries(results).forEach(([dateStr, price]) => {
    if (price !== null) {
      const dow = new Date(dateStr).getDay();
      dowTotals[dow].push(price);
    }
  });

  const dowAverages = {};
  Object.entries(dowTotals).forEach(([dow, prices]) => {
    dowAverages[dow] = prices.length > 0
      ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
      : null;
  });

  // Find cheapest & most expensive days
  const validPrices = Object.entries(results).filter(([, p]) => p !== null);
  const sortedByPrice = [...validPrices].sort((a, b) => a[1] - b[1]);
  const cheapestDays = sortedByPrice.slice(0, 3).map(([d]) => d);
  const pricestDays = sortedByPrice.slice(-3).map(([d]) => d);

  // Simple "book now or wait" recommendation
  const allPrices = validPrices.map(([, p]) => p);
  const avgPrice = allPrices.length > 0
    ? Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length)
    : null;
  const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : null;
  const maxPrice = allPrices.length > 0 ? Math.max(...allPrices) : null;

  // If current cheapest is within 10% of min, recommend booking now
  const recommendation = minPrice && avgPrice
    ? (minPrice < avgPrice * 0.9 ? 'book_now' : 'wait')
    : 'unknown';

  const data = {
    origin,
    dest,
    year,
    month,
    prices: results,
    dowAverages,
    cheapestDays,
    pricestDays,
    avgPrice,
    minPrice,
    maxPrice,
    recommendation,
  };

  cache.set(key, { data, fetchedAt: Date.now() });
  return data;
}

// Main endpoint
app.get('/api/prices', async (req, res) => {
  const { origin, dest, year, month } = req.query;

  if (!origin || !dest || !year || !month) {
    return res.status(400).json({ ok: false, error: 'origin, dest, year, month are required' });
  }
  if (!SERPAPI_KEY) {
    return res.status(500).json({ ok: false, error: 'SERPAPI_KEY not configured' });
  }

  try {
    const data = await fetchMonthPrices(
      origin.toUpperCase(),
      dest.toUpperCase(),
      parseInt(year),
      parseInt(month)
    );
    res.json({ ok: true, ...data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', hasApiKey: !!SERPAPI_KEY }));

app.listen(PORT, () => {
  console.log(`Cheapest Time to Fly server running on port ${PORT}`);
});
