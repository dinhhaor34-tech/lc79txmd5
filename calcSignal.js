/**
 * calcSignal — thuật toán dự đoán Tài/Xỉu (server-side version)
 * Sync với index.html
 */

const LOCK_TICK = 10;

// Tính velocity theo cùng logic với data-collector (snap20 vs snap5)
// snapshots là mảng { subTick, taiAmt, xiuAmt, totalAmt }
function getVelocityFromSnapshots(snapshots) {
  if (!snapshots || snapshots.length < 2) return null;
  const snap20 = snapshots.find(s => s.subTick <= 20 && s.subTick >= 18);
  const snap5  = snapshots.find(s => s.subTick <= 5);
  if (!snap20 || !snap5) return null;
  const delta = snap5.totalAmt - snap20.totalAmt;
  if (delta <= 0) return null;
  return {
    taiVel: (snap5.taiAmt - snap20.taiAmt) / delta * 100,
    xiuVel: (snap5.xiuAmt - snap20.xiuAmt) / delta * 100
  };
}

function getHistStats(history) {
  if (!history || history.length < 10) return null;
  const recent = history.slice(0, 30);
  const taiCount = recent.filter(s => s.result === 'TAI').length;
  return {
    total: recent.length,
    taiRate: taiCount / recent.length * 100,
    xiuRate: (recent.length - taiCount) / recent.length * 100
  };
}

function getStreak(history) {
  if (!history || history.length === 0) return { count: 0, type: '--' };
  const last = history[0].result;
  let count = 0;
  for (const s of history) {
    if (s.result === last) count++;
    else break;
  }
  return { count, type: last };
}

function calcSignal(taiPct, xiuPct, tick, state, streak, taiAmt, xiuAmt, history, snapshots) {
  if (state === 'RESULT') return { confidence: 0, pick: null };
  if (state === 'PREPARE_TO_START') return { confidence: 0, pick: null };
  if (tick > 30) return { confidence: 0, pick: null };
  if (state !== 'BETTING') return { confidence: 0, pick: null };

  const velocity = getVelocityFromSnapshots(snapshots);
  const histStats = getHistStats(history);
  const diff = Math.abs(taiPct - xiuPct);
  let scoreTai = 50, scoreXiu = 50;
  let reasons = [];

  // 1. Dòng tiền
  if (tick <= 20) {
    const w = tick <= LOCK_TICK ? 2.0 : 1.0;
    if (taiPct > xiuPct) {
      scoreXiu += diff * 0.4 * w;
      reasons.push(`money:TAI${taiPct.toFixed(0)}`);
    } else {
      scoreTai += diff * 0.4 * w;
      reasons.push(`money:XIU${xiuPct.toFixed(0)}`);
    }
  }

  // 2. Velocity contrarian — weight 0.5 tick≤15, 0.3 tick 16-20
  if (velocity && tick <= 20) {
    const velDiff = Math.abs(velocity.taiVel - velocity.xiuVel);
    if (velDiff > 10) {
      const velWeight = tick <= 15 ? 0.5 : 0.3;
      const fast = velocity.taiVel > velocity.xiuVel ? 'TAI' : 'XIU';
      if (fast === 'TAI') scoreXiu += velDiff * velWeight;
      else scoreTai += velDiff * velWeight;
      reasons.push(`vel:${fast}+${velDiff.toFixed(0)}`);

      // 3. Confluence
      const moneyDominant = taiPct > xiuPct ? 'TAI' : 'XIU';
      if (fast === moneyDominant) {
        if (fast === 'TAI') scoreXiu += 8;
        else scoreTai += 8;
        reasons.push('confluence');
      }
    }
  }

  // 4. Streak — chỉ đảo chiều khi có bằng chứng dòng tiền đang yếu dần
  // Không bẻ cầu bệt mù quáng: kiểm tra momentum trong phiên hiện tại
  if (streak.count >= 3) {
    // Tính momentum: dòng tiền phía streak đang tăng hay giảm trong phiên?
    // Dùng tickSnapshots nếu có, so sánh taiPct đầu phiên (subTick 25) vs cuối (subTick 5)
    let streakMomentumWeak = false;
    if (snapshots && snapshots.length >= 2) {
      const early = snapshots.find(s => s.subTick >= 20);
      const late  = snapshots.find(s => s.subTick <= 7);
      if (early && late) {
        const earlyPct = streak.type === 'TAI' ? early.taiAmt / early.totalAmt * 100 : early.xiuAmt / early.totalAmt * 100;
        const latePct  = streak.type === 'TAI' ? late.taiAmt / late.totalAmt * 100 : late.xiuAmt / late.totalAmt * 100;
        // Momentum yếu: phía streak đang mất dần tỷ lệ trong phiên này
        streakMomentumWeak = latePct < earlyPct - 3; // giảm hơn 3% → dấu hiệu đảo
      }
    }

    if (streakMomentumWeak) {
      // Momentum yếu → có khả năng đảo chiều
      const bonus = streak.count <= 4 ? 6 : streak.count <= 6 ? 10 : 14;
      if (streak.type === 'TAI') scoreXiu += bonus;
      else scoreTai += bonus;
      reasons.push(`streak:${streak.type}x${streak.count}↓weak`);
    } else {
      // Momentum vẫn mạnh → theo chiều cầu, không bẻ
      const bonus = streak.count <= 4 ? 4 : streak.count <= 6 ? 6 : 8;
      if (streak.type === 'TAI') scoreTai += bonus;
      else scoreXiu += bonus;
      reasons.push(`streak:${streak.type}x${streak.count}↑follow`);
    }
  }

  // 5. Balanced money flow — đã bỏ (không có bằng chứng đủ mạnh)

  // 6. Lịch sử (giảm weight, tăng ngưỡng)
  if (histStats && histStats.total >= 10) {
    const hDiff = Math.abs(histStats.taiRate - histStats.xiuRate);
    if (hDiff > 15) {
      if (histStats.taiRate > histStats.xiuRate) scoreXiu += hDiff * 0.1;
      else scoreTai += hDiff * 0.1;
      reasons.push(`hist:TAI${histStats.taiRate.toFixed(0)}`);
    }
  }

  const totalScore = scoreTai + scoreXiu;
  const taiConf = scoreTai / totalScore * 100;
  const xiuConf = scoreXiu / totalScore * 100;
  const pick = taiConf > xiuConf ? 'TAI' : 'XIU';
  const confidence = Math.max(taiConf, xiuConf);

  return { pick, confidence: +confidence.toFixed(1), taiConf: +taiConf.toFixed(1), xiuConf: +xiuConf.toFixed(1), reasons };
}

module.exports = { calcSignal, getStreak };
