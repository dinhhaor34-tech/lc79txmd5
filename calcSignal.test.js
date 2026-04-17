/**
 * calcSignal Upgrade Tests
 *
 * Kiểm tra các signal mới sau khi nâng cấp thuật toán:
 * - Velocity weight 0.5 (tick ≤ 15) và 0.3 (tick 16-20)
 * - Velocity window mở rộng đến tick ≤ 20
 * - Confluence signal (+8 điểm)
 * - Streak threshold giảm từ 3 → 2
 * - Balanced money flow (+6 điểm cho TAI)
 */

const fc = require('fast-check');

let tickSnapshots = [];

function recordSnap(tick, taiAmt, xiuAmt) {
  tickSnapshots.push({ tick, taiAmt, xiuAmt });
  if (tickSnapshots.length > 20) tickSnapshots.shift();
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

function getHistStats() { return null; }

// Hàm calcSignal đã nâng cấp (sync với index.html)
function calcSignal(taiPct, xiuPct, tick, state, streak, taiAmt, xiuAmt) {
  if (state === 'RESULT') return { icon: '🎲', text: 'Đang hiện kết quả', reason: '', color: '#8b949e', confidence: 0, pick: null };
  if (state === 'PREPARE_TO_START') return { icon: '⏳', text: 'Chuẩn bị phiên mới', reason: '', color: '#8b949e', confidence: 0, pick: null };
  if (tick > 30) return { icon: '⏳', text: 'Chờ thêm dữ liệu', reason: 'Còn quá sớm để phân tích', color: '#8b949e', confidence: 0, pick: null };
  if (state !== 'BETTING') return { icon: '⏳', text: 'Chờ thêm dữ liệu', reason: '', color: '#8b949e', confidence: 0, pick: null };

  recordSnap(tick, taiAmt, xiuAmt);
  const velocity = getVelocity();
  const histStats = getHistStats();
  const diff = Math.abs(taiPct - xiuPct);
  const LOCK_TICK = 10;
  let scoreTai = 50, scoreXiu = 50;
  let reasons = [];

  // 1. Dòng tiền
  if (tick <= 20) {
    const w = tick <= LOCK_TICK ? 2.0 : 1.0;
    if (taiPct > xiuPct) {
      scoreXiu += diff * 0.4 * w;
      reasons.push(`💸 Dòng tiền lệch TAI ${taiPct.toFixed(0)}% vs XIU ${xiuPct.toFixed(0)}%`);
    } else {
      scoreTai += diff * 0.4 * w;
      reasons.push(`💸 Dòng tiền lệch XIU ${xiuPct.toFixed(0)}% vs TAI ${taiPct.toFixed(0)}%`);
    }
  }

  // 2. Velocity (contrarian) — weight 0.5 tick≤15, 0.3 tick 16-20
  if (velocity && tick <= 20) {
    const velDiff = Math.abs(velocity.taiVel - velocity.xiuVel);
    if (velDiff > 10) {
      const velWeight = tick <= 15 ? 0.5 : 0.3;
      const fast = velocity.taiVel > velocity.xiuVel ? 'TAI' : 'XIU';
      if (fast === 'TAI') scoreXiu += velDiff * velWeight;
      else scoreTai += velDiff * velWeight;
      const pick = fast === 'TAI' ? 'XỈU' : 'TÀI';
      reasons.push(`⚡ Velocity ${fast} nhanh → Đặt ${pick} (contrarian +${velDiff.toFixed(0)}%)`);

      // 3. Confluence
      const moneyDominant = taiPct > xiuPct ? 'TAI' : 'XIU';
      if (tick <= 20 && fast === moneyDominant) {
        if (fast === 'TAI') scoreXiu += 8;
        else scoreTai += 8;
        reasons.push(`🎯 Confluence: velocity + dòng tiền đồng thuận → tín hiệu mạnh`);
      }
    }
  }

  // 4. Streak (threshold 2)
  if (streak.count >= 2) {
    const bonus = streak.count === 2 ? 4 : Math.min(streak.count * 3, 15);
    if (streak.type === 'TAI') scoreXiu += bonus;
    else scoreTai += bonus;
    reasons.push(`🔁 Chuỗi ${streak.type} ${streak.count} phiên → xu hướng đảo`);
  }

  // 5. Balanced money flow
  if (tick <= 20 && taiPct >= 45 && taiPct <= 55 && xiuPct >= 45 && xiuPct <= 55) {
    scoreTai += 6;
    reasons.push(`⚖️ Dòng tiền cân bằng (45-55%) → xu hướng TAI`);
  }

  // 6. Lịch sử
  if (histStats && histStats.total >= 10) {
    const hDiff = Math.abs(histStats.taiRate - histStats.xiuRate);
    if (hDiff > 10) {
      if (histStats.taiRate > histStats.xiuRate) scoreXiu += hDiff * 0.2;
      else scoreTai += hDiff * 0.2;
    }
  }

  const totalScore = scoreTai + scoreXiu;
  const taiConf = scoreTai / totalScore * 100;
  const xiuConf = scoreXiu / totalScore * 100;
  const pick = taiConf > xiuConf ? 'TAI' : 'XIU';
  const confidence = Math.max(taiConf, xiuConf);
  const pickColor = pick === 'TAI' ? '#ff7b72' : '#58a6ff';
  const pickLabel = pick === 'TAI' ? 'TÀI' : 'XỈU';
  const icon = confidence >= 65 ? '🎯' : confidence >= 55 ? '📈' : '🤔';

  return { icon, text: `${pickLabel} — ${confidence.toFixed(0)}%`, color: pickColor, reason: reasons.join('<br>'), confidence, pick, taiConf, xiuConf, scoreTai, scoreXiu };
}

// Helper: tạo velocity snapshots với tỷ lệ mong muốn
function setupVelocity(taiVel, xiuVel) {
  tickSnapshots = [];
  const baseAmt = 1000;
  const totalVel = taiVel + xiuVel;
  const nTai = (taiVel / totalVel) * 100;
  const nXiu = (xiuVel / totalVel) * 100;
  const flow = 200;
  for (let i = 0; i < 5; i++) {
    tickSnapshots.push({
      tick: i + 1,
      taiAmt: baseAmt + i * flow * nTai / 100,
      xiuAmt: baseAmt + i * flow * nXiu / 100
    });
  }
}

console.log('=== calcSignal Upgrade Tests ===\n');

let passed = 0, failed = 0;

// --- Property 1: Velocity weight 0.5 cho tick ≤ 15 ---
console.log('Property 1: Velocity weight 0.5 cho tick ≤ 15');
try {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 15 }),
    fc.integer({ min: 11, max: 50 }), // velDiff > 10
    (tick, velDiff) => {
      // Setup velocity: TAI nhanh hơn với velDiff cụ thể
      const taiVel = 50 + velDiff / 2;
      const xiuVel = 50 - velDiff / 2;
      setupVelocity(taiVel, xiuVel);
      const snap = tickSnapshots[tickSnapshots.length - 1];
      const result = calcSignal(50, 50, tick, 'BETTING', { count: 0, type: '--' }, snap.taiAmt, snap.xiuAmt);
      const vel = getVelocity();
      if (!vel) return true;
      const actualVelDiff = Math.abs(vel.taiVel - vel.xiuVel);
      const expectedBonus = actualVelDiff * 0.5;
      return Math.abs(result.scoreXiu - (50 + expectedBonus)) < 0.5;
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 2: Velocity weight 0.3 cho tick 16-20 ---
console.log('Property 2: Velocity weight 0.3 cho tick 16-20');
try {
  fc.assert(fc.property(
    fc.integer({ min: 16, max: 20 }),
    fc.integer({ min: 11, max: 50 }),
    (tick, velDiff) => {
      const taiVel = 50 + velDiff / 2;
      const xiuVel = 50 - velDiff / 2;
      setupVelocity(taiVel, xiuVel);
      const snap = tickSnapshots[tickSnapshots.length - 1];
      const result = calcSignal(50, 50, tick, 'BETTING', { count: 0, type: '--' }, snap.taiAmt, snap.xiuAmt);
      const vel = getVelocity();
      if (!vel) return true;
      const actualVelDiff = Math.abs(vel.taiVel - vel.xiuVel);
      const expectedBonus = actualVelDiff * 0.3;
      // Không được dùng weight 0.5
      return Math.abs(result.scoreXiu - (50 + expectedBonus)) < 0.5;
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 3: tick > 20 bỏ qua velocity ---
console.log('Property 3: tick > 20 bỏ qua velocity hoàn toàn');
try {
  fc.assert(fc.property(
    fc.integer({ min: 21, max: 30 }),
    (tick) => {
      setupVelocity(70, 30); // velDiff lớn, sẽ trigger nếu không bị chặn
      const snap = tickSnapshots[tickSnapshots.length - 1];
      const result = calcSignal(50, 50, tick, 'BETTING', { count: 0, type: '--' }, snap.taiAmt, snap.xiuAmt);
      // tick > 20 cũng > LOCK_TICK và > 20 nên dòng tiền cũng không chạy
      // scoreTai = scoreXiu = 50 (không có signal nào)
      return result.scoreTai === 50 && result.scoreXiu === 50;
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 4: Confluence +8 khi velocity + dòng tiền đồng thuận ---
console.log('Property 4: Confluence bonus +8 khi velocity + dòng tiền đồng thuận');
try {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 15 }),
    fc.integer({ min: 56, max: 70 }), // taiPct > 55 (TAI dominant)
    (tick, taiPct) => {
      const xiuPct = 100 - taiPct;
      // TAI velocity cũng nhanh hơn → confluence
      setupVelocity(70, 30);
      const snap = tickSnapshots[tickSnapshots.length - 1];
      const result = calcSignal(taiPct, xiuPct, tick, 'BETTING', { count: 0, type: '--' }, snap.taiAmt, snap.xiuAmt);
      // Cả velocity (TAI fast) và dòng tiền (TAI dominant) → confluence → scoreXiu += 8
      return result.reason.includes('Confluence') && result.scoreXiu > 50;
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 5: Không có confluence khi velocity và dòng tiền ngược chiều ---
console.log('Property 5: Không có confluence khi velocity và dòng tiền ngược chiều');
try {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 15 }),
    fc.integer({ min: 56, max: 70 }), // taiPct > 55 (TAI dominant money)
    (tick, taiPct) => {
      const xiuPct = 100 - taiPct;
      // XIU velocity nhanh hơn → ngược chiều với dòng tiền TAI → không confluence
      setupVelocity(30, 70);
      const snap = tickSnapshots[tickSnapshots.length - 1];
      const result = calcSignal(taiPct, xiuPct, tick, 'BETTING', { count: 0, type: '--' }, snap.taiAmt, snap.xiuAmt);
      return !result.reason.includes('Confluence');
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 6: Streak bonus đúng theo threshold mới ---
console.log('Property 6: Streak bonus đúng theo threshold mới (count ≥ 2)');
try {
  fc.assert(fc.property(
    fc.integer({ min: 2, max: 10 }),
    fc.constantFrom('TAI', 'XIU'),
    (count, type) => {
      tickSnapshots = [];
      const result = calcSignal(50, 50, 25, 'BETTING', { count, type }, 1000, 1000);
      const expectedBonus = count === 2 ? 4 : Math.min(count * 3, 15);
      if (type === 'TAI') return Math.abs(result.scoreXiu - (50 + expectedBonus)) < 0.01;
      else return Math.abs(result.scoreTai - (50 + expectedBonus)) < 0.01;
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 7: Streak < 2 không có bonus ---
console.log('Property 7: Streak < 2 không có bonus');
try {
  fc.assert(fc.property(
    fc.integer({ min: 0, max: 1 }),
    fc.constantFrom('TAI', 'XIU', '--'),
    (count, type) => {
      tickSnapshots = [];
      const result = calcSignal(50, 50, 25, 'BETTING', { count, type }, 1000, 1000);
      return result.scoreTai === 50 && result.scoreXiu === 50;
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 8: Balanced money flow +6 cho scoreTai ---
console.log('Property 8: Balanced money flow +6 cho scoreTai');
try {
  fc.assert(fc.property(
    fc.integer({ min: 45, max: 55 }),
    fc.integer({ min: 1, max: 20 }),
    (taiPct, tick) => {
      const xiuPct = 100 - taiPct;
      tickSnapshots = [];
      const result = calcSignal(taiPct, xiuPct, tick, 'BETTING', { count: 0, type: '--' }, 1000, 1000);
      return result.reason.includes('Dòng tiền cân bằng') && result.scoreTai >= 56;
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 9: Balanced flow không active khi tick > 20 ---
console.log('Property 9: Balanced flow không active khi tick > 20');
try {
  fc.assert(fc.property(
    fc.integer({ min: 21, max: 30 }),
    (tick) => {
      tickSnapshots = [];
      const result = calcSignal(50, 50, tick, 'BETTING', { count: 0, type: '--' }, 1000, 1000);
      return !result.reason.includes('Dòng tiền cân bằng');
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 11: Confidence formula invariant ---
console.log('Property 11: Confidence formula invariant');
try {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 20 }),
    fc.integer({ min: 30, max: 70 }),
    (tick, taiPct) => {
      const xiuPct = 100 - taiPct;
      tickSnapshots = [];
      const result = calcSignal(taiPct, xiuPct, tick, 'BETTING', { count: 0, type: '--' }, 1000, 1000);
      const total = result.scoreTai + result.scoreXiu;
      const expectedConf = Math.max(result.scoreTai, result.scoreXiu) / total * 100;
      const expectedPick = result.scoreTai > result.scoreXiu ? 'TAI' : 'XIU';
      return Math.abs(result.confidence - expectedConf) < 0.01 && result.pick === expectedPick;
    }
  ), { numRuns: 100 });
  console.log('✅ PASS\n'); passed++;
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Property 12: Early exit ---
console.log('Property 12: Early exit khi state không phải BETTING hoặc tick > 30');
try {
  const r1 = calcSignal(50, 50, 10, 'RESULT', { count: 0, type: '--' }, 1000, 1000);
  const r2 = calcSignal(50, 50, 10, 'PREPARE_TO_START', { count: 0, type: '--' }, 1000, 1000);
  const r3 = calcSignal(50, 50, 35, 'BETTING', { count: 0, type: '--' }, 1000, 1000);
  if (r1.confidence === 0 && r1.pick === null &&
      r2.confidence === 0 && r2.pick === null &&
      r3.confidence === 0 && r3.pick === null) {
    console.log('✅ PASS\n'); passed++;
  } else {
    console.log('❌ FAIL: early exit không trả về confidence=0 và pick=null\n'); failed++;
  }
} catch (e) { console.log(`❌ FAIL: ${e.message}\n`); failed++; }

// --- Summary ---
console.log('=== Kết Quả ===');
console.log(`Passed: ${passed} | Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
