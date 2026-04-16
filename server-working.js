const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Storage
let history = [];
let predHistory = [];
let currentTick = null;

// Auth
const USERNAME = process.env.TELE68_USER || "dinhhaor150";
const PASSWORD = process.env.TELE68_PASS || "dinhvuhao5";
let currentToken = "";

function md5(str) {
  return crypto.createHash("md5").update(str).digest("hex");
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        "Origin": "https://lc79b.bet",
        "User-Agent": "Mozilla/5.0"
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    }).on("error", reject);
  });
}

function httpPost(urlStr, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyStr = JSON.stringify(body);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        "Origin": "https://lc79b.bet",
        "User-Agent": "Mozilla/5.0"
      }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(d); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function login() {
  const pwMd5 = md5(PASSWORD);
  console.log('[AUTH] Đang đăng nhập...');
  
  const preAuth = await httpGet(
    `https://apifo88daigia.tele68.com/api?c=3&un=${USERNAME}&pw=${pwMd5}&cp=R&cl=R&pf=web&at=`
  );
  
  const accessToken = preAuth.accessToken || preAuth.data?.accessToken;
  const nickName = preAuth.nickName || preAuth.data?.nickName;
  
  if (!accessToken) throw new Error("Không lấy được accessToken");
  
  const loginResp = await httpPost(
    "https://wlb.tele68.com/v1/lobby/auth/login?cp=R&cl=R&pf=web&at=",
    { nickName: nickName || "vuhao212", accessToken }
  );
  
  const token = loginResp.token || loginResp.data?.token;
  if (!token) throw new Error("Không lấy được token");
  
  console.log('[AUTH] ✅ Đăng nhập thành công!');
  currentToken = token;
  return token;
}

function isTokenExpiringSoon(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    const now = Math.floor(Date.now() / 1000);
    return payload.exp - now < 1800;
  } catch {
    return true;
  }
}

// WebSocket connection
const WS_URL = "wss://wtxmd52.tele68.com/txmd5/?EIO=4&transport=websocket";
let ws = null;

async function connectWS() {
  // Auto login nếu token hết hạn
  if (!currentToken || isTokenExpiringSoon(currentToken)) {
    try {
      await login();
    } catch (e) {
      console.error('[AUTH] ❌ Login failed:', e.message);
      setTimeout(connectWS, 10000);
      return;
    }
  }

  console.log('[WS] Connecting...');
  ws = new WebSocket(WS_URL, {
    headers: {
      "Origin": "https://lc79b.bet",
      "User-Agent": "Mozilla/5.0"
    }
  });

  ws.on('open', () => {
    console.log('[WS] ✅ Connected!');
  });

  ws.on('message', async (data) => {
    const txt = data.toString();
    
    if (txt.startsWith('0{')) {
      ws.send(`40/txmd5,{"token":"${currentToken}"}`);
      return;
    }
    if (txt === '2') { ws.send('3'); return; }
    
    // Token bị từ chối
    if (txt.includes('"unauthorized"')) {
      console.log('[AUTH] Token rejected, re-login...');
      try {
        await login();
        ws.close();
      } catch (e) {
        console.error('[AUTH] Re-login failed:', e.message);
      }
      return;
    }

    const m = txt.match(/^42\/txmd5,(\[.+\])$/s);
    if (!m) return;
    
    try {
      const [event, payload] = JSON.parse(m[1]);
      
      if (event === 'tick-update') {
        currentTick = {
          id: payload.id,
          tick: payload.tick,
          subTick: payload.subTick,
          state: payload.state,
          data: payload.data
        };
      } else if (event === 'session-result') {
        const entry = {
          sessionId: payload.md5Raw.split(':')[0],
          result: payload.resultTruyenThong,
          dice: payload.dices
        };
        history.unshift(entry);
        if (history.length > 100) history = history.slice(0, 100);
        console.log(`[RESULT] #${entry.sessionId}: ${entry.result}`);
      } else if (event === 'new-session') {
        console.log(`[NEW] #${payload.id}`);
      }
    } catch (e) {
      console.error('[WS] Parse error:', e.message);
    }
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });

  ws.on('close', () => {
    console.log('[WS] Disconnected, reconnecting in 5s...');
    setTimeout(connectWS, 5000);
  });
}

// Helper functions
function getStreak(hist) {
  if (!hist.length) return { count: 0, type: '--' };
  const first = hist[0].result;
  let count = 0;
  for (const h of hist) { if (h.result === first) count++; else break; }
  return { count, type: first };
}

function calcSignal(taiPct, xiuPct, tick, state, streak) {
  if (state !== 'BETTING' || tick > 30) {
    return { icon: '⏳', text: 'Chờ dữ liệu', confidence: 0, pick: null };
  }

  let scoreTai = 50, scoreXiu = 50;
  const diff = Math.abs(taiPct - xiuPct);
  
  // Cầu xen kẽ
  const recent3 = history.slice(-3);
  if (recent3.length >= 2 && recent3.every((r, i) => i === 0 || r.result !== recent3[i-1].result)) {
    const lastResult = recent3[recent3.length - 1].result;
    if (lastResult === 'TAI') scoreXiu += 25;
    else scoreTai += 25;
  }
  
  // Dòng tiền
  if (tick <= 20) {
    if (taiPct > xiuPct) scoreXiu += diff * 0.4;
    else scoreTai += diff * 0.4;
  }
  
  // Streak
  if (streak.count >= 3) {
    const bonus = Math.min(streak.count * 3, 15);
    if (streak.type === 'TAI') scoreXiu += bonus;
    else scoreTai += bonus;
  }

  const totalScore = scoreTai + scoreXiu;
  const taiConf = scoreTai / totalScore * 100;
  const xiuConf = scoreXiu / totalScore * 100;
  const pick = taiConf > xiuConf ? 'TAI' : 'XIU';
  const confidence = Math.max(taiConf, xiuConf);
  const icon = confidence >= 65 ? '🎯' : confidence >= 55 ? '📈' : '🤔';

  return { icon, text: `${pick} — ${confidence.toFixed(0)}%`, confidence, pick };
}

// API Routes
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Tài Xỉu API' });
});

app.get('/api/snapshot', (req, res) => {
  res.json({ tick: currentTick, history: history.slice(0, 30), predictions: predHistory });
});

app.get('/api/dudoan', (req, res) => {
  if (!currentTick || !currentTick.data) {
    return res.json({ error: 'Chưa có dữ liệu' });
  }

  const d = currentTick;
  const data = d.data;
  const total = data.totalAmountPerType.TAI + data.totalAmountPerType.XIU;
  
  if (total <= 0) return res.json({ error: 'Chưa có dữ liệu cược' });

  const taiPct = data.totalAmountPerType.TAI / total * 100;
  const xiuPct = 100 - taiPct;
  const streak = getStreak(history);
  const signal = calcSignal(taiPct, xiuPct, d.subTick, d.state, streak);
  
  res.json({
    sessionId: d.id,
    tick: d.subTick,
    state: d.state,
    taiPct: taiPct.toFixed(2),
    xiuPct: xiuPct.toFixed(2),
    prediction: signal.pick,
    confidence: signal.confidence.toFixed(1),
    icon: signal.icon,
    text: signal.text,
    streak: streak
  });
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`👤 User: ${USERNAME}`);
  connectWS(); // Tự động login + connect
});
