const express = require("express");
const path = require("path");
const { connect, getResults, getNextSession, getCurrentTick, updateToken, getToken, setPushSSE } = require("./tele68-client");
const { analyze, recordPrediction, getPredictions } = require("./data-collector");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/result", (req, res) => {
  const results = getResults();
  const next = getNextSession();
  res.json({
    status: "ok",
    next: next ? { sessionId: next.id, md5: next.md5 } : null,
    latest: results.length ? results[0] : null
  });
});

app.get("/history", (req, res) => {
  const results = getResults();
  const next = getNextSession();
  res.json({
    status: "ok",
    next: next ? { sessionId: next.id, md5: next.md5 } : null,
    count: results.length,
    data: results
  });
});

app.get("/dulieumd5", (req, res) => {
  const results = getResults();
  res.json({
    status: "ok",
    count: results.length,
    data: results.map(r => ({
      phien: r.sessionId,
      md5: r.md5,
      md5Raw: r.md5Raw,
      ketqua: r.result
    }))
  });
});

// Endpoint cập nhật token mới không cần restart
app.post("/update-token", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ status: "error", message: "Thiếu token" });
  updateToken(token);
  res.json({ status: "ok", message: "Token đã được cập nhật, đang reconnect..." });
});

app.get("/token-status", (req, res) => {
  const token = getToken();
  if (!token) return res.json({ status: "no_token" });
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    const now = Math.floor(Date.now() / 1000);
    const remaining = payload.exp - now;
    res.json({
      status: remaining > 0 ? "ok" : "expired",
      expiresIn: remaining > 0 ? `${Math.floor(remaining / 60)} phút` : "Đã hết hạn",
      username: payload.username || payload.nickName
    });
  } catch {
    res.json({ status: "invalid_token" });
  }
});

// SSE endpoint - push live tick data tới browser
const sseClients = [];
app.get("/live", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.push(res);
  req.on("close", () => {
    const i = sseClients.indexOf(res);
    if (i !== -1) sseClients.splice(i, 1);
  });
});

function pushSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => c.write(msg));
}

// Wire pushSSE vào tele68-client
setPushSSE(pushSSE);

app.get("/live-snapshot", (req, res) => {
  const tick = getCurrentTick();
  const results = getResults();
  res.json({ tick, history: results.slice(0, 30), predictions: getPredictions() });
});

// Browser gọi khi chốt dự đoán
app.get("/predict", (req, res) => {
  const { sessionId, predicted, taiPct, xiuPct, confidence } = req.query;
  if (!sessionId || !predicted) return res.json({ status: "error" });
  recordPrediction(+sessionId, predicted, +taiPct, +xiuPct, +confidence);
  res.json({ status: "ok" });
});

// Xem accuracy của thuật toán tự động
app.get("/algo-accuracy", (req, res) => {
  const fs = require("fs");
  const DATA_FILE = require("path").join(__dirname, "sessions.jsonl");
  if (!fs.existsSync(DATA_FILE)) return res.json({ status: "no_data" });
  const lines = fs.readFileSync(DATA_FILE, "utf8").trim().split("\n").filter(Boolean);
  const sessions = lines.map(l => JSON.parse(l));
  const withAlgo = sessions.filter(s => s.algoPick);
  if (!withAlgo.length) return res.json({ status: "no_algo_data", message: "Chưa có dự đoán thuật toán nào" });

  const correct = withAlgo.filter(s => s.algoPick === s.result).length;
  const accuracy = (correct / withAlgo.length * 100).toFixed(1);

  // Breakdown theo confidence
  const highConf = withAlgo.filter(s => s.algoConfidence >= 65);
  const midConf  = withAlgo.filter(s => s.algoConfidence >= 55 && s.algoConfidence < 65);
  const lowConf  = withAlgo.filter(s => s.algoConfidence < 55);

  const breakdown = (group) => ({
    total: group.length,
    correct: group.filter(s => s.algoPick === s.result).length,
    accuracy: group.length ? (group.filter(s => s.algoPick === s.result).length / group.length * 100).toFixed(1) + '%' : 'N/A'
  });

  res.json({
    status: "ok",
    total: withAlgo.length,
    correct,
    accuracy: accuracy + '%',
    byConfidence: {
      high_65plus: breakdown(highConf),
      mid_55_65:   breakdown(midConf),
      low_under55: breakdown(lowConf)
    },
    recent: withAlgo.slice(-10).reverse().map(s => ({
      id: s.id, pick: s.algoPick, result: s.result,
      correct: s.algoPick === s.result, confidence: s.algoConfidence,
      reasons: s.algoReasons
    }))
  });
});
app.get("/sessions", (req, res) => {
  const fs = require("fs");
  const DATA_FILE = require("path").join(__dirname, "sessions.jsonl");
  if (!fs.existsSync(DATA_FILE)) return res.json({ status: "no_data", data: [] });
  const lines = fs.readFileSync(DATA_FILE, "utf8").trim().split("\n").filter(Boolean);
  const data = lines.map(l => JSON.parse(l)).reverse();
  res.json({ status: "ok", count: data.length, data });
});

// Xem lịch sử dự đoán + kết quả thực tế
app.get("/predictions", (req, res) => {
  const fs = require("fs");
  const DATA_FILE = require("path").join(__dirname, "sessions.jsonl");
  if (!fs.existsSync(DATA_FILE)) return res.json({ status: "no_data", data: [] });
  const lines = fs.readFileSync(DATA_FILE, "utf8").trim().split("\n").filter(Boolean);
  const sessions = lines.map(l => JSON.parse(l)).reverse();

  // Chỉ lấy phiên có dự đoán
  const predicted = sessions.filter(s => s.predicted);
  const correct = predicted.filter(s => s.predicted === s.result).length;
  const accuracy = predicted.length > 0 ? (correct / predicted.length * 100).toFixed(1) : null;

  res.json({
    status: "ok",
    total: predicted.length,
    correct,
    accuracy: accuracy ? `${accuracy}%` : "chưa có dữ liệu",
    data: predicted.map(s => ({
      id: s.id,
      time: s.time,
      predicted: s.predicted,
      result: s.result,
      correct: s.predicted === s.result,
      confidence: s.confidenceAtLock,
      taiPct: s.taiPctAtLock,
      xiuPct: s.xiuPctAtLock,
      dices: s.dices,
      sum: s.sum
    }))
  });
});

app.get("/analyze", (req, res) => {
  const fs = require("fs");
  const DATA_FILE = require("path").join(__dirname, "sessions.jsonl");
  if (!fs.existsSync(DATA_FILE)) return res.json({ status: "no_data", message: "Chưa có data" });
  const lines = fs.readFileSync(DATA_FILE, "utf8").trim().split("\n").filter(Boolean);
  const sessions = lines.map(l => JSON.parse(l));
  const total = sessions.length;
  if (total < 5) return res.json({ status: "not_enough", total, message: `Cần thêm data, hiện có ${total} phiên` });

  const taiCount = sessions.filter(s => s.result === "TAI").length;
  const xiuCount = total - taiCount;

  // Phân tích dòng tiền vs kết quả
  const buckets = [
    { label: "TAI > 60%", filter: s => s.taiPct > 60 },
    { label: "TAI 55-60%", filter: s => s.taiPct >= 55 && s.taiPct <= 60 },
    { label: "Cân bằng 45-55%", filter: s => s.taiPct >= 45 && s.taiPct < 55 },
    { label: "XIU 55-60%", filter: s => s.xiuPct >= 55 && s.xiuPct <= 60 },
    { label: "XIU > 60%", filter: s => s.xiuPct > 60 },
  ];

  const moneyAnalysis = buckets.map(b => {
    const group = sessions.filter(b.filter);
    if (!group.length) return null;
    const taiWin = group.filter(s => s.result === "TAI").length;
    return {
      label: b.label,
      count: group.length,
      taiRate: +(taiWin / group.length * 100).toFixed(1),
      xiuRate: +((group.length - taiWin) / group.length * 100).toFixed(1)
    };
  }).filter(Boolean);

  // Streak analysis
  const streakAnalysis = [];
  for (let streak = 2; streak <= 5; streak++) {
    let correct = 0, streakTotal = 0;
    for (let i = streak; i < sessions.length; i++) {
      const prev = sessions.slice(i - streak, i);
      if (prev.every(s => s.result === prev[0].result)) {
        streakTotal++;
        const predicted = prev[0].result === "TAI" ? "XIU" : "TAI";
        if (sessions[i].result === predicted) correct++;
      }
    }
    if (streakTotal > 0) {
      streakAnalysis.push({ streak, total: streakTotal, reverseRate: +(correct / streakTotal * 100).toFixed(1) });
    }
  }

  res.json({ status: "ok", total, taiRate: +(taiCount/total*100).toFixed(1), xiuRate: +(xiuCount/total*100).toFixed(1), moneyAnalysis, streakAnalysis });
});

app.listen(PORT, () => {
  console.log(`[API] Port ${PORT}`);
  connect();
});
