/**
 * calcSignal — thuật toán dự đoán Tài/Xỉu (server-side version)
 * Sync với index.html
 */

const LOCK_TICK = 10;
let tickSnapshots = [];

function recordSnap(tick, taiAmt, xiuAmt) {
  tickSnapshots.push({ tick, taiAmt, xiuAmt });
  if (tickSnapshots.length > 20) tickSnapshots.shift();
}

function resetSnaps() {
  tickSnapshots = [];
}

function getVelocity() {
  if (tickSnapshots.length < 3) return null;
  const recent = tickSnapshots.slice(-5);
  const oldest = recent[0], newest = recent[recent.length - 1];
  const dTai = newest.taiAmt - oldest.taiAmt;
  const dXiu = newest.xiuAmt - oldest.xiuAmt;
  const total = dTai + dXiu;
  if (total <= 0) return null;
  return { taiVel: dTai / total * 100, xiuVel: dXiu / total * 100 };
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

function calcSignal(taiPct, xiuPct, tick, state, streak, taiAmt, xiuAmt, history) {
  if (state === 'RESULT') return { confidence: 0, pick: null };
  if (state === 'PREPARE_TO_START') return { confidence: 0, pick: null };
  if (tick > 30) return { confidence: 0, pick: null };
  if (state !== 'BETTING') return { confidence: 0, pick: null };

  recordSnap(tick, taiAmt, xiuAmt);
  const velocity = getVelocity();
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

  // 4. Streak (threshold 2)
  if (streak.count >= 2) {
    const bonus = streak.count === 2 ? 4 : Math.min(streak.count * 3, 15);
    if (streak.type === 'TAI') scoreXiu += bonus;
    else scoreTai += bonus;
    reasons.push(`streak:${streak.type}x${streak.count}`);
  }

  // 5. Balanced money flow
  if (tick <= 20 && taiPct >= 45 && taiPct <= 55 && xiuPct >= 45 && xiuPct <= 55) {
    scoreTai += 6;
    reasons.push('balanced');
  }

  // 6. Lịch sử
  if (histStats && histStats.total >= 10) {
    const hDiff = Math.abs(histStats.taiRate - histStats.xiuRate);
    if (hDiff > 10) {
      if (histStats.taiRate > histStats.xiuRate) scoreXiu += hDiff * 0.2;
      else scoreTai += hDiff * 0.2;
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

module.exports = { calcSignal, resetSnaps, getStreak };
