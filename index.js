require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { ethers, WebSocketProvider } = require('ethers');
const mongoose = require('mongoose');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DEFAULT_USD_THRESHOLD = Number(process.env.DEFAULT_USD_THRESHOLD || 50000);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/web3alerts';

// --- MongoDB Schemas ---
const alertSchema = new mongoose.Schema({
  id: Number,
  chain: String,
  event_type: String,
  score: Number,
  usd_value: Number,
  tx_hash: String,
  raw: Object,
  created_at: { type: Date, default: Date.now }
});
const Alert = mongoose.model('Alert', alertSchema);

const watchlistSchema = new mongoose.Schema({
  id: Number,
  name: String,
  config: Object,
  created_at: { type: Date, default: Date.now }
});
const Watchlist = mongoose.model('Watchlist', watchlistSchema);

// --- Notifiers ---
async function sendDiscord(content) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  try { await axios.post(url, { content }); } catch {}
}
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try { await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text }); } catch {}
}
async function sendEmail(subject, text) {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return;
  try {
    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: process.env.TO_EMAIL || 'you@example.com' }] }],
      from: { email: process.env.FROM_EMAIL || 'alerts@example.com' },
      subject,
      content: [{ type: 'text/plain', value: text }]
    }, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }});
  } catch {}
}

// --- Pricing ---
const priceCache = new Map();
async function getEthUsd() {
  if (priceCache.has('eth')) return priceCache.get('eth');
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const price = r.data.ethereum.usd;
    priceCache.set('eth', price);
    setTimeout(() => priceCache.delete('eth'), 120 * 1000); // Cache for 2 minutes
    return price;
  } catch (err) {
    console.error('CoinGecko error:', err.response?.status);
    return priceCache.get('eth') || 2000;
  }
}
async function getTokenPrice(tokenAddress) {
  const key = 'token:' + tokenAddress.toLowerCase();
  if (priceCache.has(key)) return priceCache.get(key);
  const MORALIS = process.env.MORALIS_API_KEY;
  if (!MORALIS) return null;
  try {
    const url = `https://deep-index.moralis.io/api/v2/erc20/${tokenAddress}/price?chain=eth`;
    const r = await axios.get(url, { headers: { 'X-API-Key': MORALIS }});
    const out = { usdPrice: r.data.usdPrice, decimals: r.data.decimals || 18 };
    priceCache.set(key, out);
    setTimeout(() => priceCache.delete(key), 300 * 1000); // Cache for 5 minutes
    return out;
  } catch { return null; }
}

function scoreByUsd(usd) {
  if (usd >= 500000) return 99;
  if (usd >= 200000) return 92;
  if (usd >= 100000) return 85;
  if (usd >= 50000) return 70;
  if (usd >= 10000) return 55;
  return 40;
}

// --- Mempool Watcher ---
let provider = null;
if (process.env.ALCHEMY_WS_URL) {
  try {
    provider = new WebSocketProvider(process.env.ALCHEMY_WS_URL);
  } catch (err) {
    console.error('Failed to initialize WebSocket provider:', err.message);
  }
} else {
  console.log('ALCHEMY_WS_URL not set — mempool watcher disabled');
}

const V2_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] calldata path,address to,uint256 deadline) payable",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] calldata path,address to,uint256 deadline)"
];
const iface = new ethers.Interface(V2_ABI);
const KNOWN_ROUTERS = new Set([
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", // Uniswap V2
  "0xe592427a0aece92de3edee1f18e0157c05861564"  // Uniswap V3 router
]);

async function handlePending(txHash) {
  if (!provider) return;
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx || !tx.to) return;
    const to = tx.to.toLowerCase();
    if (!KNOWN_ROUTERS.has(to)) return;

    let parsed = null;
    try { parsed = iface.parseTransaction({ data: tx.data }); } catch {}

    let usdExposure = 0;
    let summary = '';

    if (parsed && parsed.name) {
      const name = parsed.name;
      const args = parsed.args;
      if (name === 'swapExactETHForTokens') {
        const ethAmt = Number(ethers.formatEther(tx.value || 0));
        const ethUsd = await getEthUsd();
        usdExposure = ethAmt * ethUsd;
        summary = `swapExactETHForTokens from ${tx.from}, ETH in ${ethAmt.toFixed(4)}`;
      } else if (name === 'swapExactTokensForTokens' || name === 'swapExactTokensForETH') {
        const amountIn = args[0];
        const path = args[2];
        const token = path && path[0] ? path[0].toLowerCase() : null;
        if (token) {
          const priceObj = await getTokenPrice(token);
          if (priceObj && priceObj.usdPrice) {
            const amt = Number(ethers.formatUnits(amountIn, priceObj.decimals || 18));
            usdExposure = amt * priceObj.usdPrice;
            summary = `${name} from ${tx.from}, token ${token}, amount ${amt.toFixed(4)}`;
          }
        }
      }
    } else {
      const ethAmt = Number(ethers.formatEther(tx.value || 0));
      if (ethAmt > 1) {
        const ethUsd = await getEthUsd();
        usdExposure = ethAmt * ethUsd;
        summary = `ETH transfer from ${tx.from} value ${ethAmt.toFixed(4)}`;
      }
    }

    if (!usdExposure || usdExposure < 100) return;

    const watchlists = await Watchlist.find();
    const isWatched = watchlists.some(wl =>
      wl.config.addresses?.includes(tx.from.toLowerCase()) ||
      wl.config.tokens?.includes(token)
    );
    if (usdExposure >= DEFAULT_USD_THRESHOLD || isWatched) {
      const score = scoreByUsd(usdExposure);
      const alert = new Alert({
        id: (await Alert.countDocuments()) + 1,
        chain: 'ethereum',
        event_type: 'pending_large_swap',
        score,
        usd_value: usdExposure,
        tx_hash: txHash,
        raw: { from: tx.from, to: tx.to },
      });
      await alert.save();

      const msg = isWatched
        ? `⚠️ Watched address/token alert ~ $${Math.round(usdExposure).toLocaleString()}
${summary}
https://etherscan.io/tx/${txHash}`
        : `⚠️ Pending large swap ~ $${Math.round(usdExposure).toLocaleString()}
${summary}
https://etherscan.io/tx/${txHash}`;
      sendDiscord(msg);
      sendTelegram(msg);
      sendEmail(isWatched ? 'Watched Alert' : 'Pending large swap', msg);
      console.log('ALERT:', txHash, Math.round(usdExposure));

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'alert', data: alert.toObject() }));
        }
      });
    }
  } catch (err) {
    console.error('Error in handlePending:', err.message);
  }
}

function startMempool() {
  if (!provider) {
    console.log('No provider, skipping mempool watcher');
    return;
  }
  let reconnectAttempts = 0;
  const maxAttempts = 5;
  function connect() {
    provider = new WebSocketProvider(process.env.ALCHEMY_WS_URL);
    console.log('Starting mempool watcher...');
    provider.on('pending', txHash => handlePending(txHash).catch(err => console.error('Pending handler error:', err)));
    provider._websocket.on('error', err => console.error('WS error:', err.message));
    provider._websocket.on('close', code => {
      console.warn('WS closed', code);
      if (reconnectAttempts < maxAttempts) {
        reconnectAttempts++;
        setTimeout(connect, 1000 * reconnectAttempts);
      }
    });
  }
  connect();
}

startMempool();

// --- API Endpoints ---
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/alerts', async (req, res) => {
  const alerts = await Alert.find().sort({ created_at: -1 }).limit(100);
  res.json(alerts);
});

app.post('/watchlists', async (req, res) => {
  const { name = 'default', config = {} } = req.body || {};
  if (typeof name !== 'string' || name.length > 50) {
    return res.status(400).json({ error: 'Invalid watchlist name' });
  }
  const id = (await Watchlist.countDocuments()) + 1;
  const wl = new Watchlist({ id, name, config });
  await wl.save();
  res.json(wl);
});

app.post('/simulate', async (req, res) => {
  const fake = new Alert({
    id: (await Alert.countDocuments()) + 1,
    chain: 'ethereum',
    event_type: 'pending_large_swap',
    score: 85,
    usd_value: 120000,
    tx_hash: '0xFAKE' + Math.floor(Math.random() * 1e6),
    raw: {},
  });
  await fake.save();
  res.json({ ok: true, fake: fake.toObject() });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'alert', data: fake.toObject() }));
    }
  });
});

// --- WebSocket Server ---
const wss = new WebSocket.Server({ port: 8080 });
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'alerts', data: Alert.find().sort({ created_at: -1 }).limit(100) }));
});

// --- Frontend ---
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Web3 Early Warning — Demo</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root { --bg: #0b1020; --card: #0f1724; --muted: #98a0b3; --accent: #00e0a8; }
    body { margin: 0; font-family: Inter, system-ui, Arial; background: var(--bg); color: #fff; }
    .wrap { max-width: 980px; margin: 28px auto; padding: 20px; }
    header { display: flex; align-items: center; gap: 16px; }
    .logo { width: 64px; height: 64px; border-radius: 12px; background: linear-gradient(135deg, #00e0a8 0, #0066ff 100%); display: flex; align-items: center; justify-content: center; font-weight: 700; color: #021; }
    h1 { margin: 0; font-size: 20px; }
    .grid { display: grid; grid-template-columns: 1fr 360px; gap: 18px; margin-top: 18px; }
    .card { background: var(--card); padding: 14px; border-radius: 10px; box-shadow: 0 6px 18px rgba(0,0,0,0.6); }
    .alert { border-left: 4px solid var(--accent); padding: 12px; margin-bottom: 10px; }
    .muted { color: var(--muted); font-size: 13px; }
    .big { font-size: 20px; font-weight: 700; }
    .btn { background: var(--accent); color: #021; padding: 8px 12px; border-radius: 8px; border: none; cursor: pointer; }
    .list { max-height: 480px; overflow: auto; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="logo">WE</div>
      <div><h1>WEB3 EARLY WARNING — Demo</h1><div class="muted">Real-time mempool alerts • Demo build</div></div>
    </header>
    <div class="grid">
      <div>
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div><div class="muted">Live Alerts</div><div class="big" id="live-count">0</div></div>
            <div><button class="btn" id="refresh">Refresh</button></div>
          </div>
          <div class="list" id="alerts"></div>
        </div>
        <div style="height:18px"></div>
        <div class="card">
          <div class="muted">Create Watchlist (demo)</div>
          <form id="wlform">
            <input id="wlname" placeholder="watchlist name" style="width:100%;padding:8px;border-radius:8px;border:none;margin-top:8px" />
            <button class="btn" style="margin-top:8px">Create</button>
          </form>
          <div id="wlmsg" class="muted"></div>
        </div>
      </div>
      <div>
        <div class="card">
          <div class="muted">Quick Stats</div>
          <div style="margin-top:10px">
            <div class="muted">Total Alerts</div><div id="total" class="big">0</div>
            <div style="height:12px"></div>
            <div class="muted">Threshold</div><div class="muted">$<span id="threshold">${DEFAULT_USD_THRESHOLD}</span></div>
          </div>
        </div>
        <div style="height:12px"></div>
        <div class="card">
          <div class="muted">Demo Actions</div>
          <div style="margin-top:10px"><button class="btn" id="fake">Insert Fake Alert</button>
          <div class="muted" style="margin-top:8px">Use this to simulate a whale alert for demo purposes.</div></div>
        </div>
      </div>
    </div>
    <footer style="margin-top:18px;text-align:center" class="muted">Built for demo — add your API keys in env to enable live alerts.</footer>
  </div>
  <script>
    const ws = new WebSocket('ws://localhost:8080');
    ws.onmessage = (event) => {
      const { type, data } = JSON.parse(event.data);
      if (type === 'alerts') {
        updateAlerts(data);
      } else if (type === 'alert') {
        updateAlerts([data], true);
      }
    };
    function updateAlerts(data, prepend = false) {
      document.getElementById('total').innerText = data.length;
      document.getElementById('live-count').innerText = data.length;
      const list = document.getElementById('alerts');
      if (prepend) {
        const el = document.createElement('div');
        el.className = 'alert';
        el.innerHTML = '<div style="display:flex;justify-content:space-between"><div><strong>$' + Math.round(data.usd_value).toLocaleString() + '</strong><div class="muted">Score ' + data.score + ' • ' + data.event_type + '</div></div><div><a href="https://etherscan.io/tx/' + data.tx_hash + '" target="_blank" style="color:#fff">View</a></div></div>';
        list.prepend(el);
      } else {
        list.innerHTML = '';
        data.forEach(a => {
          const el = document.createElement('div');
          el.className = 'alert';
          el.innerHTML = '<div style="display:flex;justify-content:space-between"><div><strong>$' + Math.round(a.usd_value).toLocaleString() + '</strong><div class="muted">Score ' + a.score + ' • ' + a.event_type + '</div></div><div><a href="https://etherscan.io/tx/' + a.tx_hash + '" target="_blank" style="color:#fff">View</a></div></div>';
          list.appendChild(el);
        });
      }
    }
    document.getElementById('refresh').addEventListener('click', () => {
      fetch('/alerts').then(r => r.json()).then(updateAlerts).catch(console.warn);
    });
    document.getElementById('wlform').addEventListener('submit', async e => {
      e.preventDefault();
      const name = document.getElementById('wlname').value || 'demo';
      const r = await fetch('/watchlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const j = await r.json();
      document.getElementById('wlmsg').innerText = 'Created ' + j.name;
    });
    document.getElementById('fake').addEventListener('click', async () => {
      await fetch('/simulate', { method: 'POST' });
    });
  </script>
</body>
</html>`);
});

// --- Start Server ---
mongoose.connect(MONGO_URI).then(() => {
  console.log('Connected to MongoDB');
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}).catch(err => console.error('MongoDB connection error:', err));