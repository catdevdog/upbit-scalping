// scripts/walkforward-validate.js
// Walk-forward validation for ML model using candle JSONL

import fs from "node:fs";
import path from "node:path";
import { CFG } from "../src/config/index.js";
import { buildFeatureVector } from "../src/ml/features.js";

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return d;
};

const input = arg(
  "input",
  path.resolve(process.cwd(), "./logs/candles_1m.jsonl")
);
const folds = Math.max(2, Number(arg("folds", 4)));
const horizonMin = Number(arg("horizon", CFG.ml.labelHorizonMin ?? 10));
const tp = Number(arg("tp", CFG.ml.tp ?? CFG.strat.TP));
const sl = Number(arg("sl", CFG.ml.sl ?? CFG.strat.SL));
const fee = Number(arg("fee", CFG.ml.fee ?? CFG.strat.FEE ?? 0));
const slip = Number(arg("slip", CFG.ml.slip ?? CFG.strat.SLIP ?? 0));

const parseJsonl = (filePath) => {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (
        Number.isFinite(row.ts) &&
        Number.isFinite(row.o) &&
        Number.isFinite(row.h) &&
        Number.isFinite(row.l) &&
        Number.isFinite(row.c)
      ) {
        out.push({
          ts: row.ts,
          o: row.o,
          h: row.h,
          l: row.l,
          c: row.c,
          v: Number(row.v || 0),
        });
      }
    } catch {}
  }
  return out;
};

function labelAt(candlesAsc, i, horizon, tpPct, slPct, feePct, slipPct) {
  const entry = candlesAsc[i].c;
  // [Audit Fix] 왕복 비용 2배 적용 + 룩어헤드 바이어스 제거
  const tpAdj = tpPct + 2 * (feePct + slipPct);
  const slAdj = slPct + 2 * (feePct + slipPct);
  const tpPrice = entry * (1 + tpAdj);
  const slPrice = entry * (1 - slAdj);

  for (let k = 1; k <= horizon; k++) {
    const c = candlesAsc[i + k];
    if (!c) break;

    // OHLC 순서 시뮬레이션
    const upFirst = c.h - c.o >= c.o - c.l;

    if (upFirst) {
      if (c.h >= tpPrice) return 1;
      if (c.l <= slPrice) return 0;
    } else {
      if (c.l <= slPrice) return 0;
      if (c.h >= tpPrice) return 1;
    }
  }
  return 0;
}

function standardize(X) {
  const n = X.length;
  const m = X[0].length;
  const mean = new Array(m).fill(0);
  const std = new Array(m).fill(0);

  for (const row of X) {
    for (let j = 0; j < m; j++) mean[j] += row[j];
  }
  for (let j = 0; j < m; j++) mean[j] /= n;

  for (const row of X) {
    for (let j = 0; j < m; j++) std[j] += (row[j] - mean[j]) ** 2;
  }
  for (let j = 0; j < m; j++) std[j] = Math.sqrt(std[j] / n) || 1;

  const norm = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  return { norm, mean, std };
}

function trainLogReg(X, y, epochs = 300, lr = 0.08, l2 = 0.0005) {
  const n = X.length;
  const m = X[0].length;
  let w = new Array(m).fill(0);
  let b = 0;

  for (let e = 0; e < epochs; e++) {
    let dw = new Array(m).fill(0);
    let db = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < m; j++) z += w[j] * X[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      for (let j = 0; j < m; j++) dw[j] += err * X[i][j];
      db += err;
    }
    for (let j = 0; j < m; j++) {
      dw[j] = dw[j] / n + l2 * w[j];
      w[j] -= lr * dw[j];
    }
    b -= lr * (db / n);
  }
  return { weights: w, bias: b };
}

function predictProba(weights, bias, row) {
  let z = bias;
  for (let j = 0; j < row.length; j++) z += weights[j] * row[j];
  return 1 / (1 + Math.exp(-z));
}

function evaluate(X, y, weights, bias) {
  let correct = 0;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < X.length; i++) {
    const p = predictProba(weights, bias, X[i]);
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
    if (pred === 1 && y[i] === 1) tp++;
    if (pred === 1 && y[i] === 0) fp++;
    if (pred === 0 && y[i] === 1) fn++;
  }
  const acc = correct / X.length;
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  return { acc, precision, recall, f1 };
}

function buildDataset(rows) {
  const featureWindow = Number(CFG.ml.featureWindow ?? 120);
  const horizon = Math.max(1, horizonMin);

  const X = [];
  const y = [];
  const ts = [];

  for (let i = featureWindow; i < rows.length - horizon - 1; i++) {
    const window = rows
      .slice(i - featureWindow + 1, i + 1)
      .slice()
      .reverse();
    const fv = buildFeatureVector({ candles1m: window, cfg: CFG });
    if (!fv) continue;

    const label = labelAt(rows, i, horizon, tp, sl, fee, slip);
    if (label == null) continue;

    X.push(fv.values);
    y.push(label);
    ts.push(rows[i].ts);
  }

  return { X, y, ts };
}

async function main() {
  const rows = parseJsonl(input).sort((a, b) => a.ts - b.ts);
  // 개선 4: 최소 데이터 1000 → 5000으로 증가
  if (rows.length < 5000) {
    throw new Error("데이터가 부족합니다. 최소 5,000개 이상 필요합니다.");
  }

  const { X, y, ts } = buildDataset(rows);
  // 개선 4: 최소 샘플 500 → 2000으로 증가
  if (X.length < 2000) {
    throw new Error("학습 가능한 샘플이 부족합니다. 기간을 늘려주세요.");
  }

  const foldSize = Math.floor(X.length / (folds + 1));
  // 개선 4: 최소 폴드 크기 200 → 400으로 증가
  if (foldSize < 400) {
    throw new Error("폴드 크기가 너무 작습니다. folds 값을 줄이세요.");
  }

  const metrics = [];
  for (let i = 1; i <= folds; i++) {
    const trainEnd = foldSize * i;
    const valEnd = Math.min(X.length, foldSize * (i + 1));

    const Xtrain = X.slice(0, trainEnd);
    const ytrain = y.slice(0, trainEnd);
    const Xval = X.slice(trainEnd, valEnd);
    const yval = y.slice(trainEnd, valEnd);

    const { norm: Xn, mean, std } = standardize(Xtrain);
    const { weights, bias } = trainLogReg(Xn, ytrain);

    const XvalNorm = Xval.map((row) =>
      row.map((v, j) => (v - mean[j]) / std[j])
    );
    const m = evaluate(XvalNorm, yval, weights, bias);
    metrics.push(m);

    const startTs = ts[trainEnd];
    const endTs = ts[valEnd - 1];
    console.log(
      `fold ${i} | samples ${Xval.length} | acc ${(m.acc * 100).toFixed(
        2
      )}% | f1 ${(m.f1 * 100).toFixed(2)}% | ${new Date(
        startTs
      ).toISOString()} ~ ${new Date(endTs).toISOString()}`
    );
  }

  const avg = metrics.reduce(
    (s, m) => ({
      acc: s.acc + m.acc,
      precision: s.precision + m.precision,
      recall: s.recall + m.recall,
      f1: s.f1 + m.f1,
    }),
    { acc: 0, precision: 0, recall: 0, f1: 0 }
  );

  const n = metrics.length || 1;
  console.log("\n✅ Walk-forward 평균");
  console.log(`- Accuracy: ${((avg.acc / n) * 100).toFixed(2)}%`);
  console.log(`- Precision: ${((avg.precision / n) * 100).toFixed(2)}%`);
  console.log(`- Recall: ${((avg.recall / n) * 100).toFixed(2)}%`);
  console.log(`- F1: ${((avg.f1 / n) * 100).toFixed(2)}%`);

  // ✅ 결과 저장 (자동 재학습용)
  const avgWinrate = avg.recall / n; // Recall = TP / (TP + FN) ≈ 승률
  const avgSharpe = (avg.f1 / n) * 2; // F1 기반 간이 Sharpe (실험적)

  const results = {
    folds,
    avgWinrate,
    avgSharpe,
    avgAccuracy: avg.acc / n,
    avgPrecision: avg.precision / n,
    avgRecall: avg.recall / n,
    avgF1: avg.f1 / n,
    foldMetrics: metrics,
    timestamp: Date.now(),
  };

  fs.writeFileSync(
    path.resolve(process.cwd(), "./logs/wf_results.json"),
    JSON.stringify(results, null, 2)
  );
  console.log("\n💾 결과 저장: ./logs/wf_results.json");
}

main().catch((e) => {
  console.error(`❌ 검증 실패: ${e?.message}`);
  process.exit(1);
});
