const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage
let history = [];
let predHistory = [];
let currentTick = null;
let wsClient = null;
let reconnectInterval = null;

// Load history from file if exists
const HISTORY_FILE = 'history.json';
const PRED_FILE = 'predictions.json';

function loadData() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`✅ Loaded ${history.length} history records`);
    }
    if (fs.existsSync(PRED_FILE)) {
      predHistory = JSON.parse(fs.readFileSync(PRED_FILE, 'utf8'));
      console.log(`✅ Loaded ${predHistory.length} prediction records`);
    }
  } catch (err) {
    console.error('❌ Error loading data:', err);
  }
}

function saveData() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(0, 100), null, 2));
    fs.writeFileSync(PRED_FILE, JSON.stringify(predHistory.slice(0, 100), null, 2));
  } catch (err) {
    console.error('❌ Error saving data:', err);
  }
}

// Load data on startup
loadData();

// Helper functions (same as index.html)
function getStreak(hist) {
  if (!hist.length) return { count: 0, type: '--' };
  const first = hist[0].result;
  let count = 0;
  for (const h of hist) { if (h.result === first) count++; else break; }
  return { count, type: first };
}

function calcSignal(taiPct, xiuPct, tick, state, streak, taiAmt, xiuAmt, velocity) {
  if (state === 'RESULT') return { icon: '🎲', text: 'Đang hiện kết quả', reason: '', color: '#8b949e', confidence: 0, pick: null };
  if (state === 'PREPARE_TO_START') return { icon: '⏳', text: 'Chuẩn bị phiên mới', reason: '', color: '#8b949e', confidence: 0, pick: null };
  if (tick > 30) return { icon: '⏳', text: 'Chờ thêm dữ liệu', reason: 'Còn quá sớm để phân tích', color: '#8b949e', confidence: 0, pick: null };
  if (state !== 'BETTING') return { icon: '⏳', text: 'Chờ thêm dữ liệu', reason: '', color: '#8b949e', confidence: 0, pick: null };

  const diff = Math.abs(taiPct - xiuPct);
  let scoreTai = 50, scoreXiu = 50;
  let reasons = [];
  
  // 0. Phát hiện cầu xen kẽ (PRIORITY 1 - 54.5% accuracy!)
  const recent3 = history.slice(-3);
  if (recent3.length >= 2) {
    const isAlternating = recent3.every((r, i) => i === 0 || r.result !== recent3[i-1].result);
    if (isAlternating) {
      const lastResult = recent3[recent3.length - 1].result;
      const velBalanced = velocity && Math.abs(velocity.taiVel - velocity.xiuVel) <= 10;
      const alternatingBonus = velBalanced ? 30 : 25;
      
      if (lastResult === 'TAI') {
        scoreXiu += alternatingBonus;
        const velNote = velBalanced ? ' + Velocity cân bằng' : '';
        reasons.unshift(`🔄 CẦU XEN KẼ: ${recent3.map(r => r.result).join('-')} → Đặt XỈU (54.5% accuracy${velNote})`);
      } else {
        scoreTai += alternatingBonus;
        const velNote = velBalanced ? ' + Velocity cân bằng' : '';
        reasons.unshift(`🔄 CẦU XEN KẼ: ${recent3.map(r => r.result).join('-')} → Đặt TÀI (54.5% accuracy${velNote})`);
      }
    }
  }
  
  // Phát hiện tình huống BẤT THƯỜNG
  let suspicious = false;
  const moneyDiff = Math.abs(taiPct - xiuPct);
  const velDiff = velocity ? Math.abs(velocity.taiVel - velocity.xiuVel) : 0;
  
  if (moneyDiff > 20 && velDiff > 30) {
    suspicious = true;
    reasons.unshift(`⚠️ BẤT THƯỜNG - Dòng tiền lệch ${moneyDiff.toFixed(0)}% + Velocity lệch ${velDiff.toFixed(0)}% → CẨN THẬN`);
  }

  // 1. Dòng tiền
  if (tick <= 20) {
    const w = tick <= 10 ? 2.0 : 1.0;
    if (taiPct > xiuPct) {
      scoreXiu += diff * 0.4 * w;
      reasons.push(`💸 Dòng tiền lệch TÀI ${taiPct.toFixed(0)}% vs XỈU ${xiuPct.toFixed(0)}%`);
    } else {
      scoreTai += diff * 0.4 * w;
      reasons.push(`💸 Dòng tiền lệch XỈU ${xiuPct.toFixed(0)}% vs TÀI ${taiPct.toFixed(0)}%`);
    }
  }

  // 2. Velocity (contrarian strategy)
  if (velocity && tick <= 15) {
    const velDiff = Math.abs(velocity.taiVel - velocity.xiuVel);
    if (velDiff > 10) {
      const fast = velocity.taiVel > velocity.xiuVel ? 'TAI' : 'XIU';
      if (fast === 'TAI') scoreXiu += velDiff * 0.3;
      else scoreTai += velDiff * 0.3;
      const pick = fast === 'TAI' ? 'XỈU' : 'TÀI';
      reasons.push(`⚡ Tiền đổ nhanh vào ${fast === 'TAI' ? 'TÀI' : 'XỈU'} → Đặt ${pick} (contrarian +${velDiff.toFixed(0)}%)`);
    }
  }

  // 3. Streak
  if (streak.count >= 3) {
    const bonus = Math.min(streak.count * 3, 15);
    if (streak.type === 'TAI') scoreXiu += bonus;
    else scoreTai += bonus;
    reasons.push(`🔁 Chuỗi ${streak.type === 'TAI' ? 'TÀI' : 'XỈU'} ${streak.count} phiên → xu hướng đảo`);
  }

  // 4. Lịch sử
  if (history.length >= 10) {
    const last = history.slice(0, Math.min(history.length, 50));
    const taiCount = last.filter(h => h.result === 'TAI').length;
    const taiRate = taiCount / last.length * 100;
    const xiuRate = 100 - taiRate;
    const hDiff = Math.abs(taiRate - xiuRate);
    
    if (hDiff > 10) {
      if (taiRate > xiuRate) scoreXiu += hDiff * 0.2;
      else scoreTai += hDiff * 0.2;
      reasons.push(`📊 Lịch sử ${last.length} phiên: TÀI ${taiRate.toFixed(0)}% | XỈU ${xiuRate.toFixed(0)}%`);
    }
  }

  const totalScore = scoreTai + scoreXiu;
  const taiConf = scoreTai / totalScore * 100;
  const xiuConf = scoreXiu / totalScore * 100;
  const pick = taiConf > xiuConf ? 'TAI' : 'XIU';
  let confidence = Math.max(taiConf, xiuConf);
  
  if (suspicious) confidence = 0;
  
  const pickColor = pick === 'TAI' ? '#ff7b72' : '#58a6ff';
  const pickLabel = pick === 'TAI' ? 'TÀI' : 'XỈU';
  const icon = suspicious ? '⚠️' : (confidence >= 65 ? '🎯' : confidence >= 55 ? '📈' : '🤔');

  return { icon, text: `${pickLabel} — ${confidence.toFixed(0)}%`, color: pickColor, reason: reasons.join(' | '), confidence, pick, taiConf, xiuConf, suspicious };
}

// API Routes
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Tài Xỉu API Server',
    endpoints: {
      snapshot: '/api/snapshot',
      history: '/api/history',
      predictions: '/api/predictions',
      dudoan: '/api/dudoan'
    }
  });
});

// GET /api/snapshot - Lấy trạng thái hiện tại
app.get('/api/snapshot', (req, res) => {
  res.json({
    tick: currentTick,
    history: history.slice(0, 30),
    predictions: predHistory.slice(0, 20)
  });
});

// GET /api/history - Lấy lịch sử
app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    total: history.length,
    data: history.slice(0, limit)
  });
});

// GET /api/predictions - Lấy lịch sử dự đoán
app.get('/api/predictions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({
    total: predHistory.length,
    data: predHistory.slice(0, limit)
  });
});

// GET /api/dudoan - Lấy dự đoán cho phiên hiện tại
app.get('/api/dudoan', (req, res) => {
  if (!currentTick || !currentTick.data) {
    return res.json({ error: 'Chưa có dữ liệu' });
  }

  const d = currentTick;
  const data = d.data;
  const total = data.totalAmountPerType.TAI + data.totalAmountPerType.XIU;
  
  if (total <= 0) {
    return res.json({ error: 'Chưa có dữ liệu cược' });
  }

  const taiPct = data.totalAmountPerType.TAI / total * 100;
  const xiuPct = 100 - taiPct;
  const streak = getStreak(history);
  
  // Calculate velocity (simplified - would need tick snapshots for real velocity)
  const velocity = null; // TODO: implement velocity tracking
  
  const signal = calcSignal(taiPct, xiuPct, d.subTick, d.state, streak, data.totalAmountPerType.TAI, data.totalAmountPerType.XIU, velocity);
  
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
    reason: signal.reason,
    streak: streak
  });
});

// POST /api/dulieu - Lưu dữ liệu (webhook từ data collector)
app.post('/api/dulieu', (req, res) => {
  const { type, data } = req.body;
  
  if (type === 'result') {
    // Lưu kết quả
    history.unshift(data);
    if (history.length > 100) history = history.slice(0, 100);
    
    // Cập nhật prediction history
    const pred = predHistory.find(p => p.id === data.sessionId || p.id === +data.sessionId);
    if (pred && !pred.result) {
      pred.result = data.result;
      pred.correct = pred.predicted === data.result;
      pred.dices = data.dice;
    }
    
    saveData();
    console.log(`✅ Saved result for session #${data.sessionId}: ${data.result}`);
  }
  
  res.json({ success: true });
});

// WebSocket connection to game server
function connectWebSocket() {
  const WS_URL = 'wss://api-t1.tele68.com/ws/sicbo';
  
  console.log('🔌 Connecting to WebSocket...');
  wsClient = new WebSocket(WS_URL);
  
  wsClient.on('open', () => {
    console.log('✅ WebSocket connected');
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
  });
  
  wsClient.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'tick') {
        currentTick = msg.data;
      } else if (msg.type === 'result') {
        const resultData = msg.data;
        history.unshift(resultData);
        if (history.length > 100) history = history.slice(0, 100);
        
        // Update prediction
        const pred = predHistory.find(p => p.id === resultData.sessionId || p.id === +resultData.sessionId);
        if (pred && !pred.result) {
          pred.result = resultData.result;
          pred.correct = pred.predicted === resultData.result;
          pred.dices = resultData.dice;
        }
        
        saveData();
        console.log(`✅ Result #${resultData.sessionId}: ${resultData.result}`);
      }
    } catch (err) {
      console.error('❌ Error parsing message:', err);
    }
  });
  
  wsClient.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });
  
  wsClient.on('close', () => {
    console.log('🔌 WebSocket disconnected, reconnecting in 5s...');
    wsClient = null;
    
    if (!reconnectInterval) {
      reconnectInterval = setInterval(() => {
        if (!wsClient || wsClient.readyState === WebSocket.CLOSED) {
          connectWebSocket();
        }
      }, 5000);
    }
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 API endpoints:`);
  console.log(`   GET  /api/snapshot`);
  console.log(`   GET  /api/history`);
  console.log(`   GET  /api/predictions`);
  console.log(`   GET  /api/dudoan`);
  console.log(`   POST /api/dulieu`);
  
  // Connect to WebSocket
  connectWebSocket();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, saving data...');
  saveData();
  if (wsClient) wsClient.close();
  process.exit(0);
});
