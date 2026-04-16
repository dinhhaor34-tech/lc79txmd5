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
let lastPrediction = null; // Lưu dự đoán cuối cùng

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
        
        // Lưu vào sessions.jsonl (format giống npm start)
        if (currentTick && currentTick.data) {
          const data = currentTick.data;
          const total = data.totalAmountPerType.TAI + data.totalAmountPerType.XIU;
          const taiAmt = data.totalAmountPerType.TAI;
          const xiuAmt = data.totalAmountPerType.XIU;
          const taiPct = total > 0 ? (taiAmt / total * 100) : 0;
          const xiuPct = 100 - taiPct;
          
          // Tính velocity (giả sử từ dữ liệu có sẵn hoặc dùng taiPct/xiuPct)
          const velTai = taiPct; // Có thể cải thiện sau
          const velXiu = xiuPct;
          
          const sessionData = {
            id: parseInt(entry.sessionId),
            md5: payload.md5Raw.split(':')[1] || '',
            result: entry.result,
            dices: entry.dice,
            sum: entry.dice.reduce((a, b) => a + b, 0),
            totalAmt: total,
            taiAmt: taiAmt,
            xiuAmt: xiuAmt,
            taiPct: parseFloat(taiPct.toFixed(2)),
            xiuPct: parseFloat(xiuPct.toFixed(2)),
            velTai: parseFloat(velTai.toFixed(2)),
            velXiu: parseFloat(velXiu.toFixed(2)),
            tickCount: currentTick.tick || 0,
            time: new Date().toISOString()
          };
          
          // Lưu vào file
          const line = JSON.stringify(sessionData) + '\n';
          fs.appendFile('sessions.jsonl', line, (err) => {
            if (err) console.error('[FILE] Error saving:', err.message);
            else console.log(`[FILE] Saved #${entry.sessionId} to sessions.jsonl`);
          });
        }
        
        // Kiểm tra dự đoán đúng/sai (sửa lỗi so sánh ID === thành ==)
        if (lastPrediction && lastPrediction.id == entry.sessionId) {
          const correct = lastPrediction.predicted === entry.result;
          const predEntry = {
            id: parseInt(entry.sessionId),
            predicted: lastPrediction.predicted,
            confidence: lastPrediction.confidence,
            result: entry.result,
            dices: entry.dice,
            correct: correct,
            time: new Date().toISOString()
          };
          
          // Ghi vào file predictions.jsonl (không giới hạn)
          fs.appendFile('predictions.jsonl', JSON.stringify(predEntry) + '\n', (err) => {
            if (err) console.error('[FILE] Error saving prediction:', err.message);
            else console.log(`[PRED] Saved prediction #${entry.sessionId} to predictions.jsonl`);
          });
          
          // Vẫn lưu vào bộ nhớ cho API snapshot (giới hạn 50)
          predHistory.unshift(predEntry);
          if (predHistory.length > 50) predHistory = predHistory.slice(0, 50);
          
          console.log(`[PRED] #${entry.sessionId}: ${lastPrediction.predicted} → ${entry.result} ${correct ? '✅' : '❌'}`);
          lastPrediction = null;
        }
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
  
  // Ưu tiên 1: Cầu xen kẽ (accuracy 62-70%)
  const recent2 = history.slice(0, 2);
  if (recent2.length >= 2 && recent2[0].result !== recent2[1].result) {
    // Pattern xen kẽ detected → dự đoán tiếp tục xen kẽ
    if (recent2[0].result === 'TAI') {
      scoreXiu += 40; // Bonus lớn cho xen kẽ
    } else {
      scoreTai += 40;
    }
  } else {
    // Không có xen kẽ → dùng FOLLOWING (theo dòng tiền)
    if (taiPct > xiuPct) {
      scoreTai += diff * 0.5; // Following: tiền vào đâu → đoán đó
    } else {
      scoreXiu += diff * 0.5;
    }
  }
  
  // Streak bonus (nhỏ hơn)
  if (streak.count >= 4) {
    const bonus = Math.min(streak.count * 2, 10);
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
  
  // Lưu dự đoán khi đang BETTING và tick >= 15 (đủ dữ liệu)
  if (d.state === 'BETTING' && d.subTick >= 15 && signal.pick && (!lastPrediction || lastPrediction.id !== d.id)) {
    lastPrediction = {
      id: d.id,
      predicted: signal.pick,
      confidence: signal.confidence
    };
    console.log(`[PRED] #${d.id}: Dự đoán ${signal.pick} (${signal.confidence.toFixed(0)}%)`);
  }
  
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

app.post('/api/dulieu', (req, res) => {
  const { sessionId, result, dice } = req.body;
  if (!sessionId || !result) {
    return res.json({ error: 'Thiếu dữ liệu' });
  }
  
  const entry = { sessionId, result, dice };
  history.unshift(entry);
  if (history.length > 100) history = history.slice(0, 100);
  
  console.log(`[DATA] Saved #${sessionId}: ${result}`);
  res.json({ success: true });
});

// API để download sessions.jsonl
app.get('/api/sessions', (req, res) => {
  fs.readFile('sessions.jsonl', 'utf8', (err, data) => {
    if (err) {
      return res.json({ error: 'Chưa có dữ liệu', sessions: [] });
    }
    const lines = data.trim().split('\n').filter(l => l);
    const sessions = lines.map(l => {
      try { return JSON.parse(l); }
      catch { return null; }
    }).filter(s => s);
    res.json({ sessions, count: sessions.length });
  });
});

// API để xóa sessions.jsonl (reset)
app.delete('/api/sessions', (req, res) => {
  fs.unlink('sessions.jsonl', (err) => {
    if (err && err.code !== 'ENOENT') {
      return res.json({ error: 'Lỗi xóa file' });
    }
    console.log('[FILE] Deleted sessions.jsonl');
    res.json({ success: true, message: 'Đã xóa dữ liệu' });
  });
});

// API /api/dungsai - Lấy toàn bộ lịch sử dự đoán (không giới hạn)
app.get('/api/dungsai', (req, res) => {
  const limit = parseInt(req.query.limit) || null;
  const offset = parseInt(req.query.offset) || 0;
  
  fs.readFile('predictions.jsonl', 'utf8', (err, data) => {
    if (err) {
      return res.json({ error: 'Chưa có dữ liệu dự đoán', predictions: [], total: 0 });
    }
    const lines = data.trim().split('\n').filter(l => l);
    const predictions = lines.map(l => {
      try { return JSON.parse(l); }
      catch { return null; }
    }).filter(p => p);
    
    // Sắp xếp theo id giảm dần (mới nhất trước)
    predictions.sort((a, b) => b.id - a.id);
    
    const total = predictions.length;
    let result = predictions;
    if (limit !== null && limit > 0) {
      const start = offset;
      const end = offset + limit;
      result = predictions.slice(start, end);
    }
    res.json({ predictions: result, total });
  });
});

// API xóa dữ liệu dự đoán
app.delete('/api/dungsai', (req, res) => {
  fs.unlink('predictions.jsonl', (err) => {
    if (err && err.code !== 'ENOENT') {
      return res.json({ error: 'Lỗi xóa file' });
    }
    console.log('[FILE] Deleted predictions.jsonl');
    predHistory = []; // Xóa luôn trong bộ nhớ
    res.json({ success: true, message: 'Đã xóa dữ liệu dự đoán' });
  });
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  console.log(`👤 User: ${USERNAME}`);
  connectWS(); // Tự động login + connect
});
