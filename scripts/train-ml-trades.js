// scripts/train-ml-trades.js
// Train ML model from actual trade log (includes orderbook features)

import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../src/config/index.js";
import { buildFeatureVectorFromSnapshot } from "../src/ml/features.js";

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return d;
};

const input = arg("input", PATHS.tradeLog);
const modelPath = arg("model", CFG.ml.modelPathOb);

function readEvents(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
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

function trainLogReg(X, y, epochs = 400, lr = 0.08, l2 = 0.0005) {
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

function buildDataset(events) {
  const exits = events.filter((e) => e.type === "EXIT");
  const samples = [];
  for (const e of exits) {
    const snap = e.entryCtx || e.ctx;
    if (!snap) continue;
    const fv = buildFeatureVectorFromSnapshot(
      snap,
      CFG.ml.useOrderbookFeatures
    );
    if (!fv) continue;
    samples.push({
      x: fv.values,
      y: Number(e.pnlKRW) > 0 ? 1 : 0,
      ts: e.exitTs ?? e.tsEpoch ?? 0,
      featureNames: fv.featureNames,
    });
  }

  if (!samples.length) return { X: [], y: [], ts: [], featureNames: null };
  const featureNames = samples[0].featureNames;
  return {
    X: samples.map((s) => s.x),
    y: samples.map((s) => s.y),
    ts: samples.map((s) => s.ts),
    featureNames,
  };
}

async function main() {
  const events = readEvents(input);
  const { X, y, ts, featureNames } = buildDataset(events);
  if (X.length < 200) {
    throw new Error("샘플 부족: 최소 200개 이상의 EXIT 기록이 필요합니다.");
  }

  const timeSplit = CFG.ml.timeSplit !== false;
  const split = timeSplit
    ? Math.floor(X.length * 0.8)
    : Math.floor(X.length * 0.8);

  let Xtrain = X.slice(0, split);
  let ytrain = y.slice(0, split);
  let Xval = X.slice(split);
  let yval = y.slice(split);

  if (!timeSplit) {
    // shuffle only if not time-split
    for (let i = X.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [X[i], X[j]] = [X[j], X[i]];
      [y[i], y[j]] = [y[j], y[i]];
      [ts[i], ts[j]] = [ts[j], ts[i]];
    }
    Xtrain = X.slice(0, split);
    ytrain = y.slice(0, split);
    Xval = X.slice(split);
    yval = y.slice(split);
  }

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
      samples: X.length,
      market: CFG.run.market,
      timeSplit,
    },
  };

  const outPath = path.resolve(process.cwd(), modelPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(model, null, 2));

  console.log(`✅ 모델 저장: ${outPath}`);
  console.log(
    `샘플: ${X.length}, LogLoss: ${baseLogLoss.toFixed(
      4
    )} → ${calLogLoss.toFixed(4)}`
  );
}

main().catch((e) => {
  console.error(`❌ 학습 실패: ${e?.message}`);
  process.exit(1);
});
