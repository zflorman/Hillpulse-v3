import express from 'express';
import morgan from 'morgan';
import nodemailer from 'nodemailer';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const PORT = process.env.PORT || 10000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const SEEN = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;

function markSeen(id) {
  SEEN.set(id, Date.now());
  for (const [k, t] of SEEN) {
    if (Date.now() - t > TTL_MS) SEEN.delete(k);
  }
}

function isSeen(id) {
  const t = SEEN.get(id);
  return t && (Date.now() - t) < TTL_MS;
}

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
        return match[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'"); 
      }
    }

    const syndicationUrl = `https://cdn.syndication.twimg.com/widgets/tweet?url=${encodeURIComponent(url)}`;
    const r2 = await fetch(syndicationUrl);
    if (r2.ok) {
      const data2 = await r2.json();
      if (data2.text) return data2.text;
    }
  } catch (err) {
    console.error('Tweet fetch failed:', err.message);
  }

  return '';
}

async function callGeminiSummary({ text, author, url }) {
  if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;

  const prompt = `Summarize this tweet for Hill comms staff in 6–17 words. Closer to 17 is prefered but not necessary. Use shorthand and abbreviations when clear (e.g., McCarthy backs CR, Jeffries opposes). Include names of any Members of Congress or key figures mentioned. Focus only on the new info or key statement. Be factual and neutral — no adjectives, hashtags, emojis, or filler. MAKE SURE TO NOT SHARE ANY INFO THAT ISNT ACCURATE TO THE ORIGINAL TEXT. Always start your summary with the username of the author for the post than a : and the text of your summary after. Then append the tweet URL on a new line starting with 'Link:'.

Tweet text: ${text || ''}
Tweet author: @${author || ''}
Tweet URL: ${url || ''}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Gemini error ' + res.status + ': ' + t);
  }
  const data = await res.json();
  const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return textOut.trim();
}

async function sendPushover({ title, message }) {
  const token = process.env.PUSHOVER_API_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return false;

  const form = new URLSearchParams();
  form.set('token', token);
  form.set('user', user);
  form.set('title', title || 'HillPulse');
  form.set('message', message);

  const r = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    body: form
  });
  return r.ok;
}

async function sendEmail({ subject, text }) {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const to = process.env.EMAIL_TO;
  const from = process.env.EMAIL_FROM || user;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);

  if (!host || !user || !pass || !to) return false;

  const transporter = nodemailer.createTransport({
    host, port, secure: false, auth: { user, pass }
  });

  await transporter.sendMail({ from, to, subject, text });
  return true;
}

app.get('/', (req, res) => {
  res.status(200).send('HillPulse Render service is up.');
});

app.post('/ingest', async (req, res) => {
  try {
    const body = req.body || {};
    const tweet = body?.data || body?.tweet || {};
    const tweetId = tweet.tweet_id || tweet.id || tweet.url || 'unknown';
    const url = tweet.url || '';
    const author = tweet.author || '';
    let text = tweet.text || '';

    if (!text && url) text = await fetchTweetText(url);
    if (!text) return res.status(400).json({ ok: false, error: 'Could not retrieve tweet text' });

    if (isSeen(tweetId)) return res.status(200).json({ ok: true, duplicate: true });
    markSeen(tweetId);

    const summary = await callGeminiSummary({ text, author, url });
    const pushed = await sendPushover({ title: 'HillPulse', message: summary });
    const emailed = await sendEmail({ subject: `HillPulse: @${author}`, text: summary });

    res.status(200).json({ ok: true, duplicate: false, summary, pushed, emailed });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log('Server listening on', PORT));
