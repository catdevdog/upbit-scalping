// scripts/train-ml-model.js
// Train a simple logistic regression model from candle JSONL

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
const modelPath = arg("model", CFG.ml.modelPath);
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
  // [Audit Fix] 왕복 비용(수수료+슬리피지) 2배 적용 + 룩어헤드 바이어스 제거
  const tpAdj = tpPct + 2 * (feePct + slipPct);
  const slAdj = slPct + 2 * (feePct + slipPct);
  const tpPrice = entry * (1 + tpAdj);
  const slPrice = entry * (1 - slAdj);

  for (let k = 1; k <= horizon; k++) {
    const c = candlesAsc[i + k];
    if (!c) break;

    // OHLC 순서 시뮬레이션: Open → High/Low 순서 가정
    const upFirst = c.h - c.o >= c.o - c.l; // 고가가 저가보다 먼저 도달했을 가능성

    if (upFirst) {
      // 상승 우선: TP 먼저 체크
      if (c.h >= tpPrice) return 1;
      if (c.l <= slPrice) return 0;
    } else {
      // 하락 우선: SL 먼저 체크
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

function trainLogReg(X, y, epochs = 400, lr = 0.08, l2 = 0.0005) {
  const n = X.length;
  const m = X[0].length;
  let w = new Array(m).fill(0);
  let b = 0;

  for (let e = 0; e < epochs; e++) {
    let dw = new Array(m).fill(0);
    let db = 0;
    let loss = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < m; j++) z += w[j] * X[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const err = p - y[i];
      for (let j = 0; j < m; j++) dw[j] += err * X[i][j];
      db += err;
      loss += -(
        y[i] * Math.log(p + 1e-9) +
        (1 - y[i]) * Math.log(1 - p + 1e-9)
      );
    }
    for (let j = 0; j < m; j++) {
      dw[j] = dw[j] / n + l2 * w[j];
      w[j] -= lr * dw[j];
    }
    b -= lr * (db / n);

    if (e % 100 === 0) {
      const avgLoss = loss / n;
      console.log(`epoch ${e} | loss ${avgLoss.toFixed(4)}`);
    }
  }
  return { weights: w, bias: b };
}

function evaluate(X, y, w, b) {
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    let z = b;
    for (let j = 0; j < X[i].length; j++) z += w[j] * X[i][j];
    const p = 1 / (1 + Math.exp(-z));
    const pred = p >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  return correct / X.length;
}

function logLossFromProbs(y, probs) {
  let loss = 0;
  for (let i = 0; i < y.length; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, probs[i]));
    loss += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
  }
  return loss / Math.max(1, y.length);
}

function fitPlattScaling(zScores, y, epochs = 300, lr = 0.01, l2 = 0.001) {
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

function shuffleInPlace(X, y) {
  for (let i = X.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [X[i], X[j]] = [X[j], X[i]];
    [y[i], y[j]] = [y[j], y[i]];
  }
}

async function main() {
  const rows = parseJsonl(input).sort((a, b) => a.ts - b.ts);
  if (rows.length < 500) {
    throw new Error("데이터가 부족합니다. 최소 500개 이상 필요합니다.");
  }

  const featureWindow = Number(CFG.ml.featureWindow ?? 120);
  const horizon = Math.max(1, horizonMin);

  const X = [];
  const y = [];
  let featureNames = null;

  for (let i = featureWindow; i < rows.length - horizon - 1; i++) {
    const window = rows
      .slice(i - featureWindow + 1, i + 1)
      .slice()
      .reverse();
    const fv = buildFeatureVector({ candles1m: window, cfg: CFG });
    if (!fv) continue;

    const label = labelAt(rows, i, horizon, tp, sl, fee, slip);
    if (label == null) continue;

    if (!featureNames) featureNames = fv.featureNames;
    X.push(fv.values);
    y.push(label);
  }

  if (X.length < 200) {
    throw new Error(
      "학습 가능한 샘플이 부족합니다. 조건을 완화하거나 기간을 늘려주세요."
    );
  }

  const timeSplit = CFG.ml.timeSplit !== false;
  if (!timeSplit) shuffleInPlace(X, y);
  const split = Math.floor(X.length * 0.8);
  const Xtrain = X.slice(0, split);
  const ytrain = y.slice(0, split);
  const Xval = X.slice(split);
  const yval = y.slice(split);

  const { norm: Xn, mean, std } = standardize(Xtrain);
  const { weights, bias } = trainLogReg(Xn, ytrain);

  const XvalNorm = Xval.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  const acc = evaluate(XvalNorm, yval, weights, bias);

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
      horizonMin: horizon,
      tp,
      sl,
      fee,
      slip,
      timeSplit,
      market: CFG.run.market,
    },
  };

  const outPath = path.resolve(process.cwd(), modelPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(model, null, 2));

  console.log(`✅ 모델 저장: ${outPath}`);
  console.log(`샘플: ${X.length}, 검증 정확도: ${(acc * 100).toFixed(2)}%`);
  console.log(
    `캘리브레이션(LogLoss): ${baseLogLoss.toFixed(4)} → ${calLogLoss.toFixed(
      4
    )}`
  );
}

main().catch((e) => {
  console.error(`❌ 학습 실패: ${e?.message}`);
  process.exit(1);
});
