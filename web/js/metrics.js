// Lichess formulas (lila: WinPercent.scala, AccuracyPercent.scala, Advice.scala).
// Evals are [cp, mate, best] per position (ply 0..N), White's point of view.

export const MATE_CP = 10000;
export const START_CP = 15;

export const clampCp = (cp, mate) =>
  mate != null ? (mate > 0 ? 1000 : -1000) : Math.max(-1000, Math.min(1000, cp ?? 0));

// Unclamped centipawns; mate in n -> +/-(10000 - n) so deeper holes sort lower.
export const rawCp = (cp, mate) =>
  mate != null ? (MATE_CP - Math.abs(mate)) * (mate > 0 ? 1 : -1) : cp ?? 0;

export const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

export function moveAccuracy(before, after) {
  if (after >= before) return 100;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (before - after)) - 3.166924740191411;
  return Math.max(0, Math.min(100, raw + 1));
}

const pstdev = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const harmonic = (xs) => xs.length / xs.reduce((a, x) => a + 1 / Math.max(x, 0.001), 0);

export function gameAccuracy(wins, whiteFirst = true) {
  const nMoves = wins.length - 1;
  if (nMoves < 2) return [null, null];
  const size = Math.max(2, Math.min(8, Math.floor(nMoves / 10)));
  const windows = [];
  for (let i = 0; i < Math.max(0, Math.min(size, wins.length) - 2); i++) windows.push(wins.slice(0, size));
  for (let i = 0; i + size <= wins.length; i++) windows.push(wins.slice(i, i + size));
  const weights = windows.map((w) => Math.max(0.5, Math.min(12, pstdev(w))));
  const per = { true: [], false: [] };
  for (let i = 0; i < nMoves; i++) {
    const whiteMoved = (i % 2 === 0) === whiteFirst;
    let before = wins[i], after = wins[i + 1];
    if (!whiteMoved) { before = 100 - before; after = 100 - after; }
    per[whiteMoved].push([moveAccuracy(before, after), weights[i]]);
  }
  const combine = (items) => {
    if (!items.length) return null;
    const weighted = items.reduce((a, [acc, w]) => a + acc * w, 0) / items.reduce((a, [, w]) => a + w, 0);
    return (weighted + harmonic(items.map(([a]) => a))) / 2;
  };
  return [combine(per.true), combine(per.false)];
}

const startMissing = (evals) => evals.length && evals[0][0] == null && evals[0][1] == null;

export function winSeries(evals) {
  return evals.map(([cp, mate], i) => winPct(i === 0 && startMissing(evals) ? START_CP : clampCp(cp, mate)));
}

// Per-ply judgement (index = ply that was just played): null | inaccuracy | mistake | blunder
export function judgements(evals, whiteFirst = true) {
  const wins = winSeries(evals);
  const out = [null];
  for (let i = 0; i + 1 < wins.length; i++) {
    const whiteMoved = (i % 2 === 0) === whiteFirst;
    const drop = whiteMoved ? wins[i] - wins[i + 1] : wins[i + 1] - wins[i];
    out.push(drop >= 15 ? "blunder" : drop >= 10 ? "mistake" : drop >= 5 ? "inaccuracy" : null);
  }
  return out;
}

export function computeMetrics(evals, myWhite, whiteFirst = true) {
  const cps = evals.map(([cp, mate]) => clampCp(cp, mate));
  if (startMissing(evals)) cps[0] = START_CP;
  const wins = cps.map(winPct);
  const [whiteAcc, blackAcc] = gameAccuracy(wins, whiteFirst);
  const sign = myWhite ? 1 : -1;
  const mine = cps.map((c) => sign * c);
  const mineRaw = evals.map(([cp, mate]) => sign * rawCp(cp, mate));
  if (startMissing(evals)) mineRaw[0] = sign * START_CP;
  const myWins = wins.map((w) => (myWhite ? w : 100 - w));

  const counts = { inaccuracy: 0, mistake: 0, blunder: 0 };
  let oppBlunders = 0;
  const losses = [];
  for (let i = 0; i + 1 < cps.length; i++) {
    const whiteMoved = (i % 2 === 0) === whiteFirst;
    const iMoved = whiteMoved === myWhite;
    const drop = iMoved ? myWins[i] - myWins[i + 1] : myWins[i + 1] - myWins[i];
    if (iMoved) {
      losses.push(Math.max(0, mine[i] - mine[i + 1]));
      if (drop >= 15) counts.blunder++;
      else if (drop >= 10) counts.mistake++;
      else if (drop >= 5) counts.inaccuracy++;
    } else if (drop >= 15) oppBlunders++;
  }

  let leadChanges = 0, leader = 0;
  for (const c of cps) {
    const side = c > 150 ? 1 : c < -150 ? -1 : 0;
    if (side && leader && side !== leader) leadChanges++;
    if (side) leader = side;
  }

  let minPly = 0, maxPly = 0;
  mineRaw.forEach((v, i) => {
    if (v < mineRaw[minPly]) minPly = i;
    if (v > mineRaw[maxPly]) maxPly = i;
  });
  return {
    my_accuracy: myWhite ? whiteAcc : blackAcc,
    opp_accuracy: myWhite ? blackAcc : whiteAcc,
    my_acpl: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
    my_min_cp: mineRaw[minPly],
    my_min_cp_ply: minPly,
    my_max_cp: mineRaw[maxPly],
    my_max_cp_ply: maxPly,
    my_min_winpct: Math.min(...myWins),
    my_max_winpct: Math.max(...myWins),
    my_inaccuracies: counts.inaccuracy,
    my_mistakes: counts.mistake,
    my_blunders: counts.blunder,
    opp_blunders: oppBlunders,
    my_final_cp: mineRaw[mineRaw.length - 1],
    lead_changes: leadChanges,
  };
}
