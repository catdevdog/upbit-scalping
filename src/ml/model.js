// src/ml/model.js
// Simple logistic regression model loader/inference

import fs from "node:fs";
import path from "node:path";
import { logistic } from "../util/math.js";

let cache = {
  path: null,
  model: null,
  mtimeMs: 0,
};

function normalize(values, mean, std) {
  return values.map((v, i) => {
    const m = mean?.[i] ?? 0;
    const s = std?.[i] ?? 1;
    return (v - m) / (s || 1);
  });
}

export function loadModel(modelPath) {
  if (!modelPath) return null;
  const absPath = path.resolve(process.cwd(), modelPath);
  try {
    const stat = fs.statSync(absPath);
    if (cache.path === absPath && cache.mtimeMs === stat.mtimeMs) {
      return cache.model;
    }
    const raw = fs.readFileSync(absPath, "utf8");
    const model = JSON.parse(raw);
    cache = { path: absPath, model, mtimeMs: stat.mtimeMs };
    return model;
  } catch {
    return null;
  }
}

export function predictProbability(model, values) {
  if (!model || !Array.isArray(values)) return NaN;
  const norm = normalize(values, model.mean, model.std);
  let z = model.bias ?? 0;
  for (let i = 0; i < norm.length; i++) {
    z += (model.weights?.[i] ?? 0) * norm[i];
  }
  const base = logistic(z);
  const cal = model.calibration;
  if (
    cal?.method === "platt" &&
    Number.isFinite(cal.a) &&
    Number.isFinite(cal.b)
  ) {
    return logistic(cal.a * z + cal.b);
  }
  return base;
}
