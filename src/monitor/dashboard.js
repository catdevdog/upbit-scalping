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

export function renderDashboard(d) {
  const now = Date.now();
  if (now - __lastTs < CFG.ui.minRenderMs) return;
  __lastTs = now;

  const out = [];
  const line = (s = "") => out.push(s);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 헤더
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  line("╔" + "═".repeat(78) + "╗");
  line(`║ ${bold(cyan("⚡ 업비트 승률우선 Bot v4.0"))}${" ".repeat(50)}║`);

  const apiStatus =
    d.mode === "LIVE"
      ? d.account?.balanceKRW > 0
        ? green("LIVE-OK")
        : red("LIVE-오류")
      : yellow("PAPER");
  line(
    `║ ${dim(d.time)}  ${cyan(d.market)}  [${apiStatus}]${" ".repeat(
      78 - 9 - d.time.length - d.market.length - 9
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
    `│ ${bold(
      "추세"
    )}  ${trendIcon} EMA ${emaFast} / ${emaSlow}   VWAP ${vwapVal} ${vwapIcon}${" ".repeat(
      73 -
        25 -
        String(emaFast).length -
        String(emaSlow).length -
        String(vwapVal).length
    )}│`
  );

  // ATR
  const atrVal = Number.isFinite(d.atrPct) ? d.atrPct.toFixed(3) : "N/A";
  const atrIcon = d.atrPass ? green("✓") : red("✗");
  line(
    `│ ${bold("ATR")}   ${atrIcon} ${atrVal}% ${bar(
      d.atrPct / 0.1,
      15
    )}${" ".repeat(73 - 28 - atrVal.length)}│`
  );

  // RVOL
  const rvolVal = d.rvol?.toFixed(2) ?? "0.00";
  const rvolIcon = d.filters?.rvol ? green("✓") : red("✗");
  line(
    `│ ${bold("RVOL")}  ${rvolIcon} ${rvolVal}x ${bar(
      d.rvol / 2.5,
      15
    )}${" ".repeat(73 - 28 - rvolVal.length)}│`
  );

  // 호가
  const imbVal = ((d.obm?.imbalance ?? 0) * 100).toFixed(0);
  const spreadVal = d.obm?.spreadTicks ?? 0;
  const obIcon = d.filters?.spread ? green("✓") : red("✗");
  line(
    `│ ${bold(
      "호가"
    )}  ${obIcon} 불균형 ${imbVal}%  스프레드 ${spreadVal}틱${" ".repeat(
      73 - 30 - imbVal.length - String(spreadVal).length
    )}│`
  );

  line(
    "└─────────────────────────────────────────────────────────────────────────┘"
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
  line(`${bold("🎲 확률")}  p=${pVal}%  p*=${pStarVal}%  ${deltaStr}`);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 진입 차단 사유 (있을 경우만)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (d.blockReason) {
    line("");
    line(`${red("🚫 진입 차단:")} ${d.blockReason}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 성과
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
  line(`├─ 승률: ${wrColor(wr.toFixed(1) + "%")}  (목표: ${green("75%+")})`);
  line(`└─ 누적: ${fmtPnl(totalPnl)} KRW`);

  // 오늘 성과
  if (d.daily) {
    const dWins = d.daily.wins ?? 0;
    const dLosses = d.daily.losses ?? 0;
    const dTrades = d.daily.trades ?? 0;
    const dPnl = d.daily.pnl ?? 0;
    const targetMin = CFG.run.targetTradesMin;
    const targetMax = CFG.run.targetTradesMax;

    line(
      `   ${cyan(
        "오늘:"
      )} ${dTrades}/${targetMin}-${targetMax}건  승${dWins} 패${dLosses}  ${fmtPnl(
        dPnl
      )} KRW`
    );
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
