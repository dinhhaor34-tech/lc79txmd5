/**
 * Thu thập data từng phiên: tick-by-tick + kết quả
 * Lưu vào sessions.jsonl (mỗi dòng = 1 phiên hoàn chỉnh)
 */
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "sessions.jsonl");

let currentSession = null; // phiên đang theo dõi
let sessionCount = 0;
let predictions = []; // lịch sử dự đoán { id, predicted, result, correct, taiPct, xiuPct, time }

function startSession(id, md5) {
  currentSession = {
    id,
    md5,
    startTime: Date.now(),
    ticks: [],       // snapshot mỗi tick
    result: null,    // kết quả cuối
    dices: null,
    sum: null
  };
}

function recordTick(tickData) {
  if (!currentSession) return;
  if (tickData.id !== currentSession.id) return;
  currentSession.ticks.push({
    tick: tickData.tick,
    subTick: tickData.subTick,
    state: tickData.state,
    taiAmt: tickData.data.totalAmountPerType.TAI,
    xiuAmt: tickData.data.totalAmountPerType.XIU,
    taiUsers: tickData.data.totalUsersPerType.TAI,
    xiuUsers: tickData.data.totalUsersPerType.XIU,
    totalAmt: tickData.data.totalAmount,
    totalUsers: tickData.data.totalUniqueUsers,
    ts: tickData.timestamp
  });
}

function recordResult(entry) {
  if (!currentSession) return;
  currentSession.result = entry.result;
  currentSession.dices = entry.dice;
  currentSession.sum = entry.sum;
  currentSession.endTime = Date.now();

  // So sánh với prediction nếu có
  if (currentSession.predicted) {
    const correct = currentSession.predicted === entry.result;
    predictions.unshift({
      id: currentSession.id,
      predicted: currentSession.predicted,
      result: entry.result,
      correct,
      taiPct: currentSession.taiPctAtLock,
      xiuPct: currentSession.xiuPctAtLock,
      confidence: currentSession.confidenceAtLock,
      dices: entry.dice,
      time: new Date().toISOString()
    });
  }

  saveSession();
}

function recordPrediction(sessionId, predicted, taiPct, xiuPct, confidence) {
  if (!currentSession || currentSession.id !== sessionId) return;
  currentSession.predicted = predicted;
  currentSession.taiPctAtLock = taiPct;
  currentSession.xiuPctAtLock = xiuPct;
  currentSession.confidenceAtLock = confidence;
}

// Lưu dự đoán tự động của thuật toán (không cần người dùng chốt tay)
function recordAlgoPrediction(sessionId, pick, confidence, taiPct, xiuPct, reasons) {
  if (!currentSession || currentSession.id !== sessionId) return;
  currentSession.algoPick = pick;
  currentSession.algoConfidence = confidence;
  currentSession.algoTaiPct = taiPct;
  currentSession.algoXiuPct = xiuPct;
  currentSession.algoReasons = reasons;
}

function getPredictions() { return predictions; }

function saveSession() {
  if (!currentSession || !currentSession.result) return;
  if (currentSession.ticks.length < 5) return; // bỏ phiên thiếu data

  // Tính thêm các chỉ số tổng hợp
  const ticks = currentSession.ticks;
  const lastTick = ticks[ticks.length - 1];
  const totalAmt = lastTick ? lastTick.totalAmt : 0;
  const taiAmt = lastTick ? lastTick.taiAmt : 0;
  const xiuAmt = lastTick ? lastTick.xiuAmt : 0;
  const taiPct = totalAmt > 0 ? taiAmt / totalAmt * 100 : 50;
  const xiuPct = 100 - taiPct;

  // Velocity: so sánh subTick 20 vs subTick 5 (giây thực tế trong BETTING)
  const bettingTicks = ticks.filter(t => t.state === 'BETTING');
  const snap20 = bettingTicks.find(t => t.subTick <= 20 && t.subTick >= 18);
  const snap5  = bettingTicks.find(t => t.subTick <= 5);
  let velTai = null, velXiu = null;
  if (snap20 && snap5) {
    const delta = snap5.totalAmt - snap20.totalAmt;
    if (delta > 0) {
      velTai = (snap5.taiAmt - snap20.taiAmt) / delta * 100;
      velXiu = (snap5.xiuAmt - snap20.xiuAmt) / delta * 100;
    }
  }

  // Lưu snapshots tick quan trọng để phân tích sau (không lưu hết để tránh quá nặng)
  // Lấy các tick ở subTick: 25, 20, 15, 10, 5 trong BETTING
  const keySubTicks = [25, 20, 15, 10, 5];
  const tickSnapshots = keySubTicks.map(st => {
    const snap = bettingTicks.find(t => t.subTick <= st && t.subTick >= st - 2);
    if (!snap) return null;
    return {
      subTick: snap.subTick,
      taiAmt: snap.taiAmt,
      xiuAmt: snap.xiuAmt,
      totalAmt: snap.totalAmt,
      taiPct: snap.totalAmt > 0 ? +(snap.taiAmt / snap.totalAmt * 100).toFixed(2) : 50,
      xiuPct: snap.totalAmt > 0 ? +(snap.xiuAmt / snap.totalAmt * 100).toFixed(2) : 50,
    };
  }).filter(Boolean);

  const record = {
    id: currentSession.id,
    md5: currentSession.md5,
    result: currentSession.result,
    dices: currentSession.dices,
    sum: currentSession.sum,
    totalAmt,
    taiAmt,
    xiuAmt,
    taiPct: +taiPct.toFixed(2),
    xiuPct: +xiuPct.toFixed(2),
    velTai: velTai !== null ? +velTai.toFixed(2) : null,
    velXiu: velXiu !== null ? +velXiu.toFixed(2) : null,
    tickCount: ticks.length,
    tickSnapshots, // snapshots tại subTick 25,20,15,10,5
    // Dự đoán tự động của thuật toán tại tick khóa
    algoPick: currentSession.algoPick || null,
    algoConfidence: currentSession.algoConfidence || null,
    algoTaiPct: currentSession.algoTaiPct || null,
    algoXiuPct: currentSession.algoXiuPct || null,
    algoReasons: currentSession.algoReasons || null,
    time: new Date(currentSession.startTime).toISOString()
  };

  fs.appendFileSync(DATA_FILE, JSON.stringify(record) + "\n");
  sessionCount++;
  console.log(`[DATA] Lưu phiên #${record.id} | ${record.result} | TAI ${record.taiPct}% | XIU ${record.xiuPct}% | Vel TAI ${record.velTai}% XIU ${record.velXiu}% | Tổng: ${sessionCount} phiên`);
  currentSession = null;
}

// Đọc và phân tích data đã thu thập
function analyze() {
  if (!fs.existsSync(DATA_FILE)) {
    console.log("[ANALYZE] Chưa có data");
    return;
  }

  const lines = fs.readFileSync(DATA_FILE, "utf8").trim().split("\n").filter(Boolean);
  const sessions = lines.map(l => JSON.parse(l));
  const total = sessions.length;

  if (total < 10) {
    console.log(`[ANALYZE] Chỉ có ${total} phiên, cần ít nhất 10`);
    return;
  }

  console.log(`\n===== PHÂN TÍCH ${total} PHIÊN =====`);

  // 1. Tỉ lệ TAI/XIU thực tế
  const taiCount = sessions.filter(s => s.result === "TAI").length;
  const xiuCount = total - taiCount;
  console.log(`\n[1] Tỉ lệ thực tế: TAI ${(taiCount/total*100).toFixed(1)}% | XIU ${(xiuCount/total*100).toFixed(1)}%`);

  // 2. Khi đám đông vào TAI nhiều (>55%) → kết quả thực tế là gì?
  const taiHeavy = sessions.filter(s => s.taiPct > 55);
  const xiuHeavy = sessions.filter(s => s.xiuPct > 55);
  if (taiHeavy.length > 0) {
    const taiHeavyResult = taiHeavy.filter(s => s.result === "TAI").length;
    console.log(`\n[2] Khi TAI > 55% dòng tiền (${taiHeavy.length} phiên):`);
    console.log(`    → Kết quả TAI: ${(taiHeavyResult/taiHeavy.length*100).toFixed(1)}% | XIU: ${((taiHeavy.length-taiHeavyResult)/taiHeavy.length*100).toFixed(1)}%`);
  }
  if (xiuHeavy.length > 0) {
    const xiuHeavyResult = xiuHeavy.filter(s => s.result === "XIU").length;
    console.log(`\n[3] Khi XIU > 55% dòng tiền (${xiuHeavy.length} phiên):`);
    console.log(`    → Kết quả XIU: ${(xiuHeavyResult/xiuHeavy.length*100).toFixed(1)}% | TAI: ${((xiuHeavy.length-xiuHeavyResult)/xiuHeavy.length*100).toFixed(1)}%`);
  }

  // 3. Velocity analysis — khi tiền đổ nhanh vào TAI cuối phiên
  const velSessions = sessions.filter(s => s.velTai !== null);
  if (velSessions.length > 5) {
    const velTaiHigh = velSessions.filter(s => s.velTai > 60);
    const velXiuHigh = velSessions.filter(s => s.velXiu > 60);
    if (velTaiHigh.length > 0) {
      const correct = velTaiHigh.filter(s => s.result === "TAI").length;
      console.log(`\n[4] Khi velocity TAI > 60% cuối phiên (${velTaiHigh.length} phiên):`);
      console.log(`    → Kết quả TAI: ${(correct/velTaiHigh.length*100).toFixed(1)}%`);
    }
    if (velXiuHigh.length > 0) {
      const correct = velXiuHigh.filter(s => s.result === "XIU").length;
      console.log(`\n[5] Khi velocity XIU > 60% cuối phiên (${velXiuHigh.length} phiên):`);
      console.log(`    → Kết quả XIU: ${(correct/velXiuHigh.length*100).toFixed(1)}%`);
    }
  }

  // 4. Streak analysis
  console.log(`\n[6] Phân tích streak:`);
  for (let streak = 2; streak <= 5; streak++) {
    let correct = 0, total_streak = 0;
    for (let i = streak; i < sessions.length; i++) {
      const prev = sessions.slice(i - streak, i);
      if (prev.every(s => s.result === prev[0].result)) {
        total_streak++;
        // Dự đoán đảo chiều
        const predicted = prev[0].result === "TAI" ? "XIU" : "TAI";
        if (sessions[i].result === predicted) correct++;
      }
    }
    if (total_streak > 0) {
      console.log(`    Sau streak ${streak}: đảo chiều đúng ${(correct/total_streak*100).toFixed(1)}% (${total_streak} lần)`);
    }
  }

  console.log(`\n=====================================\n`);
}

module.exports = { startSession, recordTick, recordResult, recordPrediction, recordAlgoPrediction, getPredictions, analyze };
