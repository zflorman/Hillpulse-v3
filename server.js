import express from 'express';
import morgan from 'morgan';
import nodemailer from 'nodemailer';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 10000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET || '';

function assertAuthorized(req) {
  if (!INGEST_SECRET) return true;
  const h = req.get('X-HillPulse-Key') || req.get('Authorization') || '';
  return h === INGEST_SECRET || h === `Bearer ${INGEST_SECRET}`;
}

// --- Gemini with retry ---
async function callGeminiSummary({ text, author, url }) {
  if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

  const prompt = `Summarize this tweet for Hill comms staff in 6–17 words. Use shorthand and abbreviations when clear. Be factual and neutral. Always start with @username: ... Then append the tweet URL.`;

  const body = { contents: [{ role: "user", parts: [{ text: `${prompt}\n\nTweet text: ${text}\nTweet author: @${author}\nTweet URL: ${url}` }] }] };

  const MAX_RETRIES = 3;
  let attempt = 0;
  let lastErr;

  while (attempt <= MAX_RETRIES) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.status === 503) throw new Error('Gemini overload 503');
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Gemini error ${res.status}: ${t}`);
      }
      const data = await res.json();
      const out = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return out.trim();
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt <= MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        console.warn(`Gemini attempt ${attempt} failed (${err.message}). Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`Gemini failed after ${MAX_RETRIES + 1} attempts: ${lastErr?.message}`);
}

// --- Tweet fetch helper ---
async function fetchTweetText(url) {
  if (!url) return '';
  try {
    const oEmbedUrl = `https://publish.twitter.com/oembed?omit_script=1&hide_thread=1&url=${encodeURIComponent(url)}`;
    const r1 = await fetch(oEmbedUrl);
    if (r1.ok) {
      const data = await r1.json();
      const html = data.html || '';
      const match = html.match(/<p[^>]*>(.*?)<\/p>/);
      if (match) {
        return match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); 
      }
    }
    const syndUrl = `https://cdn.syndication.twimg.com/widgets/tweet?url=${encodeURIComponent(url)}`;
    const r2 = await fetch(syndUrl);
    if (r2.ok) {
      const data2 = await r2.json();
      if (data2.text) return data2.text;
    }
  } catch (err) {
    console.error('Tweet fetch failed:', err.message);
  }
  return '';
}

// --- Pushover ---
async function sendPushover({ title, message, url }) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return false;
  const form = new URLSearchParams();
  form.set('token', token);
  form.set('user', user);
  form.set('title', title || 'HillPulse');
  form.set('message', message);
  if (url) form.set('url', url);
  const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: form });
  return r.ok;
}

app.get('/', (_req, res) => res.send('HillPulse v1.2.1 running with Gemini retry logic'));

app.post('/ingest', async (req, res) => {
  try {
    if (!assertAuthorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const body = req.body || {};
    const tweet = body.data || {};
    const url = tweet.url || '';
    const author = tweet.author || '';
    let text = tweet.text || '';
    if (!text && url) text = await fetchTweetText(url);
    if (!text) return res.status(400).json({ ok: false, error: 'Missing tweet text' });

    const summary = await callGeminiSummary({ text, author, url });
    const pushed = await sendPushover({ title: 'HillPulse', message: summary, url });
    res.json({ ok: true, summary, pushed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log('Server listening on', PORT));
