// src/monitor/dashboard.js
// 승률 우선 전략용 간결한 대시보드

import { CFG } from "../config/index.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const color = (s, c) => c + s + C.reset;
const green = (s) => color(s, C.green);
const red = (s) => color(s, C.red);
const yellow = (s) => color(s, C.yellow);
const cyan = (s) => color(s, C.cyan);
const blue = (s) => color(s, C.blue);
const bold = (s) => color(s, C.bold);
const dim = (s) => color(s, C.dim);

let __prevBuf = "";
let __lastTs = 0;
let __ttyInitialized = false;

export function initTTY() {
  if (__ttyInitialized) return;
  __ttyInitialized = true;
  if (CFG.ui.useAltScreen) process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l"); // 커서 숨김

  const restore = () => {
    process.stdout.write("\x1b[?25h");
    if (CFG.ui.useAltScreen) process.stdout.write("\x1b[?1049l");
  };

  process.on("exit", restore);
  ["SIGINT", "SIGTERM"].forEach((s) =>
    process.on(s, () => {
      restore();
      process.exit(0);
    })
  );
}

function homeAndClear() {
  process.stdout.write("\x1b[H\x1b[J");
}

function bar(ratio, width = 20) {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  const empty = width - filled;
  return green("█".repeat(filled)) + dim("░".repeat(empty));
}

function fmtKRW(value) {
  const val = Number.isFinite(value) ? value : 0;
  return Math.round(Math.abs(val)).toLocaleString();
}

function fmtPnl(value) {
  const val = Number.isFinite(value) ? value : 0;
  if (val >= 0) return green("+" + fmtKRW(val));
  return red("-" + fmtKRW(val));
}

function fmtPct(value) {
  const val = Number.isFinite(value) ? value : 0;
  const sign = val >= 0 ? "+" : "";
  return `${sign}${val.toFixed(2)}%`;
}

function padLine(content, width = 73) {
  const plain = String(content).replace(/\x1b\[[0-9;]*m/g, "");
  const spaces = Math.max(0, width - plain.length);
  return `│ ${content}${" ".repeat(spaces)}│`;
}

export function renderDashboard(d) {
  const now = Date.now();
  if (now - __lastTs < CFG.ui.minRenderMs) return;
  __lastTs = now;

  const out = [];
  const line = (s = "") => out.push(s);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 헤더
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const appVersion = process.env.APP_VERSION || "v3.1-Intraday";
  const appTitle = process.env.APP_NAME || "업비트 수익매매 Bot";
  line("╔" + "═".repeat(78) + "╗");
  line(
    `║ ${bold(cyan(`⚡ ${appTitle} ${appVersion}`))}${" ".repeat(
      75 - appTitle.length - appVersion.length
    )}║`
  );

  const effectiveMode =
    d.account?.mode ?? d.mode ?? (CFG.run.paper ? "PAPER" : "LIVE");
  const syncedAt = Number(d.account?.balanceSyncedAt ?? 0);
  const syncAgeMs = syncedAt > 0 ? now - syncedAt : Number.POSITIVE_INFINITY;
  const apiStatus =
    effectiveMode === "PAPER"
      ? yellow("PAPER")
      : syncAgeMs <= 30_000
      ? green("LIVE-OK")
      : syncAgeMs <= 120_000
      ? yellow("LIVE-지연")
      : red("LIVE-오류");
  line(
    `║ ${dim(d.time)}  ${cyan(d.market)}  [${apiStatus}]${" ".repeat(
      78 - 9 - d.time.length - d.market.length - 5
    )}║`
  );
  line("╚" + "═".repeat(78) + "╝");

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 포지션 상태
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  line("");
  // 계좌 정보
  const account = d.account ?? {};
  const krwBalance = account.balanceKRW ?? 0;
  const baseHoldings = account.baseHoldings;
  const equity = account.equityKRW ?? krwBalance;

  line(
    `${bold("💳 계좌")}  KRW: ${cyan(fmtKRW(krwBalance))}  |  총자산: ${cyan(
      fmtKRW(equity)
    )}`
  );
  if (baseHoldings && baseHoldings.total > 0) {
    line(`   ${baseHoldings.currency}: ${baseHoldings.total.toFixed(8)}`);
  }

  line("");

  if (d.position) {
    const { entry, tp, sl, size } = d.position;
    const unrealPnl = d.unrealized?.pnlKRW ?? 0;
    const unrealPct = d.unrealized?.pnlPct ?? 0;
    const aliveSec = d.aliveSec ?? 0;
    const remainSec = Math.max(0, d.timeoutSec - aliveSec);

    line(`${green("● 보유 중")}  ${yellow(fmtKRW(d.price))} KRW`);
    line(`├─ 진입: ${fmtKRW(entry)}  수량: ${size.toFixed(8)}`);
    line(
      `├─ 익절: ${green(fmtKRW(tp))} ${fmtPct(
        (tp / entry - 1) * 100
      )}  손절: ${red(fmtKRW(sl))} ${fmtPct((sl / entry - 1) * 100)}`
    );
    line(
      `├─ 미실현: ${fmtPnl(unrealPnl)} KRW ${
        unrealPct >= 0 ? green(fmtPct(unrealPct)) : red(fmtPct(unrealPct))
      }`
    );
    line(`└─ 보유: ${aliveSec}s / ${d.timeoutSec}s  (남은시간: ${remainSec}s)`);

    if (d.position.partialTakePrice) {
      line(
        `   ${cyan("💰 부분익절:")} ${fmtKRW(
          d.position.partialTakePrice
        )} × ${d.position.partialTakeSize.toFixed(8)} = ${fmtPnl(
          d.position.partialTakePnL
        )} KRW`
      );
    }
  } else {
    const status = d.canEnter
      ? green("✓ 진입 대기 중")
      : yellow("○ 조건 미충족");
    line(`${status}  ${yellow(fmtKRW(d.price))} KRW`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 핵심 지표 (간결)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  line("");
  line(bold("📊 핵심 지표"));
  line(
    "┌─────────────────────────────────────────────────────────────────────────┐"
  );

  // 추세
  const trendIcon = d.trend?.pass ? green("✓") : red("✗");
  const emaFast = Math.round(d.trend?.emaFast ?? 0);
  const emaSlow = Math.round(d.trend?.emaSlow ?? 0);
  const vwapVal = d.trend?.vwap ? Math.round(d.trend.vwap) : "N/A";
  const vwapIcon = d.trend?.aboveVWAP ? green("↑") : red("↓");
  line(
    padLine(
      `${bold(
        "추세"
      )} ${trendIcon} EMA ${emaFast}/${emaSlow} | VWAP ${vwapVal} ${vwapIcon}`
    )
  );

  // ATR
  const atrVal = Number.isFinite(d.atrPct) ? d.atrPct.toFixed(3) : "N/A";
  const atrIcon = d.atrPass ? green("✓") : red("✗");
  line(
    padLine(
      `${bold("변동성")} ${atrIcon} ATR ${atrVal}% ${bar(d.atrPct / 0.1, 17)}`
    )
  );

  // RVOL
  const rvolVal = d.rvol?.toFixed(2) ?? "0.00";
  const rvolIcon = d.filters?.rvol ? green("✓") : red("✗");
  line(
    padLine(
      `${bold("거래량")} ${rvolIcon} RVOL ${rvolVal}x ${bar(d.rvol / 2.5, 17)}`
    )
  );

  // 호가
  const imbVal = ((d.obm?.imbalance ?? 0) * 100).toFixed(0);
  const spreadVal = d.obm?.spreadTicks ?? 0;
  const obIcon = d.filters?.spread ? green("✓") : red("✗");
  line(
    padLine(`${bold("오더북")} ${obIcon} Imb ${imbVal}% | Spr ${spreadVal}틱`)
  );

  line(
    "└─────────────────────────────────────────────────────────────────────────┘"
  );
  line(
    dim(
      "용어: EMA=지수이평, VWAP=거래량가중평균, ATR=변동성, RVOL=상대거래량, Imb=불균형, Spr=스프레드"
    )
  );

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 확률
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const pVal = ((d.p ?? 0) * 100).toFixed(1);
  const pStarVal = ((d.pStar ?? 0) * 100).toFixed(1);
  const delta = ((d.p ?? 0) - (d.pStar ?? 0)) * 100;
  const deltaStr =
    delta >= 0 ? green(`+${delta.toFixed(1)}%`) : red(`${delta.toFixed(1)}%`);

  line("");
  line(
    `${bold(
      "🎲 확률"
    )}  예측확률(p)=${pVal}%  임계확률(p*)=${pStarVal}%  차이(Δ) ${deltaStr}`
  );

  if (d.modelPerf?.count) {
    const mp = d.modelPerf;
    const wr = (mp.winrate * 100).toFixed(1);
    const avgP = (mp.avgProb * 100).toFixed(1);
    const brier = mp.brier.toFixed(4);
    const ll = mp.logLoss.toFixed(4);
    const scale = Number.isFinite(mp.avgSizeScale)
      ? (mp.avgSizeScale * 100).toFixed(0)
      : "-";
    line(
      `${bold("🤖 ML 성능")}  샘플 ${
        mp.count
      }  승률 ${wr}%  평균확률(p) ${avgP}%`
    );
    line(
      `   브라이어(Brier) ${brier}  로그손실(LogLoss) ${ll}  평균 비중(Size) ${scale}%`
    );
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 시장 모드 (TREND/RANGE/NEUTRAL)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (d.marketMode) {
    const modeColor =
      d.marketMode === "TREND"
        ? green
        : d.marketMode === "RANGE"
        ? cyan
        : yellow;
    const modeIcon =
      d.marketMode === "TREND" ? "📈" : d.marketMode === "RANGE" ? "↔️" : "⏸️";
    const atrRatioStr = Number.isFinite(d.atrRatio)
      ? d.atrRatio.toFixed(2)
      : "N/A";

    line("");
    line(
      `${bold("🎯 시장 모드")}  ${modeColor(
        modeIcon + " " + d.marketMode
      )}  ATR비율: ${atrRatioStr}x`
    );

    // 모드 설명
    if (d.marketMode === "TREND") {
      line(dim("   → TREND: ML 확률(p≥p*) 기반 진입, 고변동성 추세추종"));
    } else if (d.marketMode === "RANGE") {
      line(dim("   → RANGE: BB하단 근접 시 진입, 저변동성 평균회귀"));
    } else {
      line(dim("   → NEUTRAL: RANGE로 처리됨"));
    }

    if (d.bb && Number.isFinite(d.bb.lower)) {
      const bbLower = Math.round(d.bb.lower);
      const bbMiddle = Math.round(d.bb.middle);
      const bbUpper = Math.round(d.bb.upper);
      line(
        `   BB: ${red(fmtKRW(bbLower))} < ${yellow(fmtKRW(bbMiddle))} < ${green(
          fmtKRW(bbUpper)
        )}`
      );
    }

    if (d.rangeEnabled && d.todayRangeTradeCount !== undefined) {
      line(`   레인지 거래: ${d.todayRangeTradeCount}/5건`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 진입 차단 사유 (있을 경우만)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (d.blockReason) {
    line("");
    line(`${red("🚫 진입 차단:")} ${d.blockReason}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 성과 부분 수정 (거래 건수 표시 추가)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const stats = d.stats ?? {};
  const wins = stats.wins ?? 0;
  const losses = stats.losses ?? 0;
  const totalTrades = stats.trades ?? 0;
  const wr = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const wrColor = wr >= 75 ? green : wr >= 65 ? yellow : red;
  const totalPnl = stats.pnl ?? 0;

  line("");
  line(bold("📈 성과"));
  line(`├─ 총 거래: ${totalTrades}건  승: ${green(wins)}  패: ${red(losses)}`);
  line(`├─ 승률: ${wrColor(wr.toFixed(1) + "%")}  (목표: ${green("65%+")})`);
  line(`└─ 누적: ${fmtPnl(totalPnl)} KRW`);

  // ✅ 오늘 성과 + 거래 건수 진행률
  if (d.daily) {
    const dWins = d.daily.wins ?? 0;
    const dLosses = d.daily.losses ?? 0;
    const dTrades = d.daily.trades ?? 0;
    const dPnl = d.daily.pnl ?? 0;
    const targetMin = d.targetTradesMin ?? 10;
    const targetMax = d.targetTradesMax ?? 15;
    const todayCount = d.todayTradeCount ?? 0;

    // 진행률 표시
    const progress = Math.min(100, (todayCount / targetMax) * 100);
    const progressBar = bar(progress / 100, 20);

    line(
      `   ${cyan(
        "오늘:"
      )} ${todayCount}/${targetMin}-${targetMax}건 ${progressBar}`
    );
    line(`   승${dWins} 패${dLosses}  ${fmtPnl(dPnl)} KRW`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 최근 거래 (간결하게 5건만)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  line("");
  line(bold("📝 최근 거래 (5건)"));

  const recent = (d.lastTrades ?? []).slice(-5);
  if (!recent.length) {
    line(dim("   (기록 없음)"));
  } else {
    for (const t of recent) {
      const pnl = Number(t.pnlKRW) ?? 0;
      const icon = pnl >= 0 ? green("●") : red("●");
      const time = t.ts?.slice(11, 19) ?? "??:??:??";
      const reason = t.reason ?? "?";
      line(`   ${icon} ${time} ${reason.padEnd(8)} ${fmtPnl(pnl)} KRW`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 시스템 로그 (에러만, 최근 3건)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const sysLog = (d.systemLog ?? []).slice(-3).filter((e) => e.msg);
  if (sysLog.length > 0) {
    line("");
    line(bold("⚠️  최근 이벤트"));
    for (const evt of sysLog) {
      const time = evt.ts?.slice(11, 19) ?? "??:??:??";
      const msg = evt.msg?.slice(0, 60) ?? "";
      line(`   ${yellow("!")} ${time} ${msg}`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 푸터
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  line("");
  line(dim("─".repeat(80)));
  line(dim("Tip: 승률 75%+ 목표 | 하루 3-5건 | 정확한 타이밍에 집중"));
  line("");

  const buf = out.join("\n");
  if (buf === __prevBuf) return;
  __prevBuf = buf;

  homeAndClear();
  process.stdout.write(buf);
}
