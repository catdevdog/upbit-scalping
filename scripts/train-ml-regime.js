// scripts/train-ml-regime.js
// Train separate ML models for low/high volatility regimes

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
const modelPathLow = arg("modelLow", CFG.ml.modelPathLow);
const modelPathHigh = arg("modelHigh", CFG.ml.modelPathHigh);
const horizonMin = Number(arg("horizon", CFG.ml.labelHorizonMin ?? 10));
const tp = Number(arg("tp", CFG.ml.tp ?? CFG.strat.TP));
const sl = Number(arg("sl", CFG.ml.sl ?? CFG.strat.SL));
const fee = Number(arg("fee", CFG.ml.fee ?? CFG.strat.FEE ?? 0));
const slip = Number(arg("slip", CFG.ml.slip ?? CFG.strat.SLIP ?? 0));
const atrThreshold = Number(arg("atr", CFG.ml.regimeAtrThreshold ?? 0.06));

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
  const tpAdj = tpPct + feePct + slipPct;
  const slAdj = slPct + feePct + slipPct;
  const tpPrice = entry * (1 + tpAdj);
  const slPrice = entry * (1 - slAdj);

  for (let k = 1; k <= horizon; k++) {
    const c = candlesAsc[i + k];
    if (!c) break;
    const hitTP = c.h >= tpPrice;
    const hitSL = c.l <= slPrice;
    if (hitTP && hitSL) return null;
    if (hitSL) return 0;
    if (hitTP) return 1;
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

function trainLogReg(X, y, epochs = 350, lr = 0.08, l2 = 0.0005) {
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

function logLossFromProbs(y, probs) {
  let loss = 0;
  for (let i = 0; i < y.length; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, probs[i]));
    loss += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
  }
  return loss / Math.max(1, y.length);
}

function fitPlattScaling(zScores, y, epochs = 250, lr = 0.01, l2 = 0.001) {
  let a = 1;
  let b = 0;
  const n = zScores.length;
  for (let e = 0; e < epochs; e++) {
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i++) {
      const z = a * zScores[i] + b;
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      da += err * zScores[i];
      db += err;
    }
    da = da / n + l2 * a;
    db = db / n;
    a -= lr * da;
    b -= lr * db;
  }
  return { a, b };
}

function buildDataset(rows) {
  const featureWindow = Number(CFG.ml.featureWindow ?? 120);
  const horizon = Math.max(1, horizonMin);

  const low = { X: [], y: [] };
  const high = { X: [], y: [] };
  let featureNames = null;

  for (let i = featureWindow; i < rows.length - horizon - 1; i++) {
    const window = rows
      .slice(i - featureWindow + 1, i + 1)
      .slice()
      .reverse();
    const fv = buildFeatureVector({ candles1m: window, cfg: CFG });
    if (!fv) continue;
    if (!featureNames) featureNames = fv.featureNames;

    const label = labelAt(rows, i, horizon, tp, sl, fee, slip);
    if (label == null) continue;

    const target = Number(fv.meta?.atrPct) >= atrThreshold ? high : low;
    target.X.push(fv.values);
    target.y.push(label);
  }

  return { low, high, featureNames };
}

function trainAndSave(dataset, modelPath, label, featureNames) {
  if (dataset.X.length < 200) {
    console.warn(`⚠️ ${label} 샘플 부족: ${dataset.X.length}`);
    return;
  }

  const split = Math.floor(dataset.X.length * 0.8);
  const Xtrain = dataset.X.slice(0, split);
  const ytrain = dataset.y.slice(0, split);
  const Xval = dataset.X.slice(split);
  const yval = dataset.y.slice(split);

  const { norm: Xn, mean, std } = standardize(Xtrain);
  const { weights, bias } = trainLogReg(Xn, ytrain);

  const XvalNorm = Xval.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  const zVal = XvalNorm.map((row) => {
    let z = bias;
    for (let j = 0; j < row.length; j++) z += weights[j] * row[j];
    return z;
  });
  const probsRaw = zVal.map((z) => 1 / (1 + Math.exp(-z)));
  const baseLogLoss = logLossFromProbs(yval, probsRaw);
  const calib = fitPlattScaling(zVal, yval);
  const probsCal = zVal.map(
    (z) => 1 / (1 + Math.exp(-(calib.a * z + calib.b)))
  );
  const calLogLoss = logLossFromProbs(yval, probsCal);

  const model = {
    featureNames,
    mean,
    std,
    weights,
    bias,
    calibration: {
      method: "platt",
      a: calib.a,
      b: calib.b,
      logLossBefore: baseLogLoss,
      logLossAfter: calLogLoss,
    },
    meta: {
      trainedAt: new Date().toISOString(),
      samples: dataset.X.length,
      horizonMin: horizonMin,
      tp,
      sl,
      fee,
      slip,
      regime: label,
      atrThreshold,
      market: CFG.run.market,
    },
  };

  const outPath = path.resolve(process.cwd(), modelPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(model, null, 2));
  console.log(`✅ ${label} 모델 저장: ${outPath}`);
  console.log(
    `${label} LogLoss: ${baseLogLoss.toFixed(4)} → ${calLogLoss.toFixed(4)}`
  );
}

async function main() {
  const rows = parseJsonl(input).sort((a, b) => a.ts - b.ts);
  if (rows.length < 1000) {
    throw new Error("데이터가 부족합니다. 최소 1000개 이상 필요합니다.");
  }

  const { low, high, featureNames } = buildDataset(rows);
  trainAndSave(low, modelPathLow, "LOW_VOL", featureNames);
  trainAndSave(high, modelPathHigh, "HIGH_VOL", featureNames);
}

main().catch((e) => {
  console.error(`❌ 학습 실패: ${e?.message}`);
  process.exit(1);
});
