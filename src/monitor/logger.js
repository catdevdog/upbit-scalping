// 대시보드 렌더러 — 깜빡임 저감 + 확장된 용어 설명(친절/가독성 강화)
import { nowKSTString, clamp } from "../util/math.js";
import { CFG } from "../config/index.js";
import { getWsLagMs } from "../api/upbitAdapter.js";
import { parseRemainingReq } from "../core/rateLimiter.js";

const WIDTH = 30;
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};
const color = (s, c) => c + s + C.reset;
export const green = (s) => color(s, C.green);
export const red = (s) => color(s, C.red);
export const yellow = (s) => color(s, C.yellow);
export const cyan = (s) => color(s, C.cyan);
export const bold = (s) => color(s, C.bold);
export const dim = (s) => color(s, C.dim);

const fmtSignedKRW = (value) => {
  const val = Number.isFinite(value) ? value : 0;
  const sign = val > 0 ? "+" : val < 0 ? "-" : "";
  return `${sign}${Math.round(Math.abs(val)).toLocaleString()} KRW`;
};
const fmtPnlKRW = (value) => {
  const val = Number.isFinite(value) ? value : 0;
  return val >= 0
    ? green("+" + Math.round(Math.abs(val)).toLocaleString())
    : red("-" + Math.round(Math.abs(val)).toLocaleString());
};

let __prevBuf = "";
let __lastTs = 0;
let __ttyInitialized = false;

export function initTTY() {
  if (__ttyInitialized) return;
  __ttyInitialized = true;
  if (CFG.ui.useAltScreen) process.stdout.write("\x1b[?1049h"); // 대체 화면 버퍼
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

function homeAndClearToEnd() {
  process.stdout.write("\x1b[H\x1b[J"); // 홈 이동 + 커서~끝 지움
}

export function safeBar(ratio, good = true) {
  const r = Number.isFinite(ratio) ? ratio : 0;
  const filled = Math.round(clamp(r, 0, 1) * WIDTH);
  const empty = WIDTH - filled;
  const block = good ? C.green + "█" + C.reset : C.yellow + "█" + C.reset;
  return block.repeat(filled) + dim("░".repeat(empty));
}

/**
 * 용어 설명 섹션(가독성 강화판)
 * - 요청 항목: RSI, RVOL, Orderbook, Candle, p, p*, LONG/TIMEOUT, EMA (+ VWAP 등)
 * - p*는 현재 TP/SL/FEE/SLIP을 반영해 수식+값을 동시 표기
 */
function glossary(d) {
  const bar =
    "────────────────────────────────────────────────────────────────────────────────";
  const num = (x, p = 3) => (Number.isFinite(x) ? x.toFixed(p) : "NaN");

  const tp = Number(CFG.strat.TP);
  const sl = Number(CFG.strat.SL);
  const fee = Number(CFG.strat.FEE);
  const slip = Number(CFG.strat.SLIP);
  const pStar = d?.pStar ?? (sl + fee + slip) / (tp + sl);

  const lines = [];

  lines.push(bar);
  lines.push(bold("ℹ 용어 설명(핵심 지표) — v3.0"));
  lines.push(
    `${cyan("• RSI")}: 모멘텀(0~100). 50↑ 강세 경향, 70↑ 과열 경향. ` +
      `대시보드 막대는 45~65 구간 중심으로 정규화된 스코어입니다.`
  );
  lines.push(
    `${cyan("• RVOL")}: 상대거래량 = 최근 5분 평균 ÷ 기준 120분 평균. ` +
      `1.0은 평소, 1.3↑이면 활발. 체결력·슬리피지에 직접 영향.`
  );
  lines.push(
    `${cyan("• Orderbook")}: 호가창 상태 요약. ` +
      `${bold("imb")}=매수/매도 잔량 불균형(%), ${bold(
        "spreadT"
      )}=b1~a1 틱 간격, ${bold("b1/a1")}=최우선 호가. ` +
      `imb 높고 spreadT 낮을수록 유리.`
  );
  lines.push(
    `${cyan("• Candle")}: 변동성 지표(ATR%) 기반 스코어. ` +
      `현재 구현은 ${bold(
        "CandleScore = clamp((ATR%-0.10)/0.30, 0, 1)"
      )} 로 단순화.`
  );

  lines.push("");
  lines.push(bold("ℹ 추세·기준가"));
  lines.push(
    `${cyan("• EMA")}: 지수이동평균. ${bold(
      "EMA20/EMA50(5분봉)"
    )}을 사용. EMA20>EMA50이면 상방 추세로 간주.`
  );
  lines.push(
    `${cyan("• VWAP")}: 거래량가중평균가. 현재가 ≥ VWAP이면 상대적 강세로 해석.`
  );

  lines.push("");
  lines.push(bold("ℹ 확률·임계치"));
  lines.push(
    `${cyan(
      "• p"
    )}: 현재 신호( RSI/RVOL/OB/Candle )를 가중합→로지스틱으로 변환한 “성공확률 추정치”.`
  );
  lines.push(
    `${cyan("• p*")}: 손익분기 임계확률. ${bold(
      "p* = (SL + FEE + SLIP) / (TP + SL)"
    )}`
  );
  lines.push(
    `  현재 설정값으로는 ⇒ p* ≈ (${num(sl, 4)} + ${num(fee, 4)} + ${num(
      slip,
      4
    )}) / (${num(tp, 4)} + ${num(sl, 4)}) ` +
      `= ${bold(
        (pStar * 100).toFixed(1) + "%"
      )}.  p ≥ p*일 때만 장기 기대값이 양(+)입니다.`
  );

  lines.push("");
  lines.push(bold("ℹ 포지션/청산 상태"));
  lines.push(`${cyan("• LONG")}: 매수 포지션(상승 방향 베팅).`);
  lines.push(
    `${cyan("• TIMEOUT")}: 시간 제한 청산. 설정된 ${bold(
      CFG.strat.TIMEOUT_SEC + "s"
    )} 안에 목표 도달 실패 시 시장가로 정리.`
  );
  lines.push(
    `${cyan(
      "• 본절/트레일링"
    )}: 일정 수익 도달 시 손절을 본절가 근처로 이동(BE), 고점 대비 하락 폭으로 추적 청산(TRAIL).`
  );

  lines.push("");
  lines.push(bold("ℹ 해석 팁"));
  lines.push(
    `• ${bold("진입 대기")}는 보통 ${bold("ATR% 하한")}과 ${bold(
      "RVOL 임계"
    )}가 동시에 부족할 때 길어집니다.`
  );
  lines.push(
    `• ${bold("확률 p")}가 ${bold(
      "p*"
    )}보다 낮으면 규칙상 미진입이 정상입니다. ` +
      `빈도↑가 필요하면 RVOL/ATR 임계를 소폭 완화하세요.`
  );
  lines.push("");
  return lines;
}

export function renderDashboard(d) {
  const now = Date.now();
  if (now - __lastTs < CFG.ui.minRenderMs) return;
  __lastTs = now;

  // WS lag & Remaining-Req quick log
  try {
    const wsLag = getWsLagMs(d.market);
    const rr = d.lastHeaders?.get?.("Remaining-Req") ?? d.lastRemainingReq;
    const { sec, min } = parseRemainingReq(rr ?? "");
    if (wsLag != null) console.log(`[WS] lag_ms=${wsLag}`);
    if (sec != null)
      console.log(`[RATE] remaining.sec=${sec} remaining.min=${min ?? "n/a"}`);
  } catch (e) {}

  const out = [];
  const line = (s = "") => out.push(s);

  // 헤더
  line(
    "════════════════════════════════════════════════════════════════════════════════"
  );
  line(
    ` ${bold("⚡ " + d.title)}   ${dim(d.time)}   ${cyan(d.market)}  [${
      d.mode
    }]`
  );
  line(
    "════════════════════════════════════════════════════════════════════════════════"
  );

  // 상태·가격
  const pctFmt = (pct) => `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  const status = d.position
    ? `${green("보유 중")}  entry ${Math.round(
        d.position.entry
      ).toLocaleString()}  TP ${Math.round(
        d.position.tp
      ).toLocaleString()} (${pctFmt(
        (d.position.tp / d.position.entry - 1) * 100
      )})  SL ${Math.round(d.position.sl).toLocaleString()} (${pctFmt(
        (d.position.sl / d.position.entry - 1) * 100
      )})`
    : d.canEnter
    ? green("즉시 진입 가능")
    : yellow("대기");
  line(`\n🧭 상태: ${status}`);
  line(`💰 가격: ${d.price.toLocaleString()} KRW`);

  if (d.account) {
    const {
      balanceKRW,
      lockedKRW = 0,
      positionValue,
      equityKRW,
      realizedKRW,
      mode,
    } = d.account;
    line(
      `💳 계좌(${mode ?? "-"}): 가용 ${fmtSignedKRW(
        balanceKRW
      )}  |  잠금 ${fmtSignedKRW(lockedKRW)}  |  포지션 ${fmtSignedKRW(
        positionValue
      )}  |  총합 ${fmtSignedKRW(equityKRW)}`
    );
    line(`   ↳ 실현손익: ${fmtPnlKRW(realizedKRW)} KRW`);
  }

  const targetLine = `🎯 목표: +${(CFG.strat.TP * 100).toFixed(2)}% / -${(
    CFG.strat.SL * 100
  ).toFixed(2)}%  |  BE ${(CFG.strat.BE_TRIGGER * 100).toFixed(2)}% → ${(
    CFG.strat.BE_OFFSET * 100
  ).toFixed(2)}%  |  Trail ${(CFG.strat.TRAIL_PCT * 100).toFixed(
    2
  )}%  |  Timeout ${CFG.strat.TIMEOUT_SEC}s (stall ${CFG.strat.STALL_SEC}s)`;
  line(targetLine);

  if (d.position) {
    const toTp = d.position.tp - d.price;
    const toSl = d.price - d.position.sl;
    line(
      `   ↳ 남은 거리: TP ${
        toTp >= 0
          ? `${green("+" + Math.round(Math.abs(toTp)).toLocaleString())}`
          : `${red("-" + Math.round(Math.abs(toTp)).toLocaleString())}`
      } KRW  /  SL ${
        toSl >= 0
          ? `${red("-" + Math.round(Math.abs(toSl)).toLocaleString())}`
          : `${green("+" + Math.round(Math.abs(toSl)).toLocaleString())}`
      } KRW`
    );
  }

  // Trend/VWAP
  const trendTxt = d.trend?.pass ? green("PASS") : red("FAIL");
  const vwapTxt = Number.isFinite(d.trend?.vwap)
    ? `${Math.round(d.trend.vwap).toLocaleString()}`
    : "NaN";
  line(
    `\n📈 Trend : EMA${d.trend?.fastP}/${d.trend?.slowP} → ${Math.round(
      d.trend?.emaFast || 0
    ).toLocaleString()} / ${Math.round(
      d.trend?.emaSlow || 0
    ).toLocaleString()}  |  VWAP ${vwapTxt}  (${trendTxt}${
      d.trend?.aboveVWAP ? " • ↑" : " • ↓"
    })`
  );

  // 지표
  const atrTxt = Number.isFinite(d.atrPct)
    ? `${d.atrPct.toFixed(3)}% [${d.atrLo?.toFixed?.(3) ?? "NaN"}% ~ ${
        d.atrHi?.toFixed?.(3) ?? "NaN"
      }%] ${d.atrPass ? "✅" : "⛔"}`
    : "NaN% [NaN ~ NaN] ⛔";
  line(`\n📐 ATR% : ${atrTxt}`);
  line(`📦 RVOL : ${d.rvol.toFixed(2)}x  (목표 ≥ ${d.rvolMin.toFixed(2)}x)`);
  line(
    `📘 OB   : imb=${(d.obm.imbalance * 100).toFixed(1)}%  spreadT=${
      d.obm.spreadTicks
    }  b1/a1=${d.obm.bid1}/${d.obm.ask1}`
  );

  if (d.filters) {
    const fmt = (ok) => (ok ? green("PASS") : red("FAIL"));
    line(
      `\n🧰 필터: ATR ${fmt(d.filters.atr)}  RVOL ${fmt(
        d.filters.rvol
      )}  Spread ${fmt(d.filters.spread)}`
    );
  }

  // 부족치
  if (d.deficits?.length) {
    line(`\n❗ 부족/조건 미충족:`);
    for (const m of d.deficits) line(`   - ${m}`);
  }

  // 스코어
  const pct = (r) => `${(r * 100).toFixed(1)}%`;
  line(`\n🎯 스코어`);
  line(`   RSI       ${safeBar(d.scores.rsi, true)} ${pct(d.scores.rsi)}`);
  line(`   RVOL      ${safeBar(d.scores.vol, true)} ${pct(d.scores.vol)}`);
  line(`   Orderbook ${safeBar(d.scores.ob, true)} ${pct(d.scores.ob)}`);
  line(
    `   Candle    ${safeBar(d.scores.candle, true)} ${pct(d.scores.candle)}`
  );

  // 확률
  const delta = (d.p - d.pStar) * 100;
  line(
    `\n🧮 확률 p: ${(d.p * 100).toFixed(1)}% / 임계 p*: ${(
      d.pStar * 100
    ).toFixed(1)}%  ${
      delta >= 0
        ? green(`(+${delta.toFixed(1)}%)`)
        : red(`(${delta.toFixed(1)}%)`)
    }`
  );

  if (d.gateStats?.attempts) {
    const gs = d.gateStats;
    const passRate = gs.attempts
      ? ((gs.gatingPass / gs.attempts) * 100).toFixed(1)
      : "0.0";
    line(
      `\n📊 진입 모니터: 시도 ${gs.attempts} / 통과 ${gs.gatingPass} (${passRate}%) / 체결 ${gs.entries}`
    );
    line(
      `   ↳ 실패 ATR ${gs.atrFail} · RVOL ${gs.rvolFail} · Spread ${gs.spreadFail} · Prob ${gs.probFail} · Trend ${gs.trendFail} · Momentum ${gs.momentumUsed}`
    );
  }

  // 미실현·타임아웃
  if (d.position) {
    const ur = d.unrealized?.pnlKRW ?? 0;
    const urPct = d.unrealized?.pnlPct ?? 0;
    const alive = Math.max(0, d.aliveSec | 0);
    const remain = Math.max(0, (d.timeoutSec | 0) - alive);
    line(
      `\n📈 미실현손익: ${
        ur >= 0
          ? green("+" + Math.round(ur).toLocaleString())
          : red(Math.round(ur).toLocaleString())
      } KRW  (${urPct >= 0 ? green(pctFmt(urPct)) : red(pctFmt(urPct))})`
    );
    line(`⏳ 보유시간: ${alive}s  |  타임아웃까지: ${remain}s`);
  }

  // 체결 이력
  line(`\n📝 최근 체결(최대 10건)`);
  if (!d.lastTrades?.length) {
    line(`   - 기록 없음`);
  } else {
    for (const e of d.lastTrades.slice(-10)) {
      const sign = Number(e.pnlKRW) >= 0 ? "🟢" : "🔴";
      const pnl =
        Number(e.pnlKRW) >= 0
          ? green("+" + Math.round(e.pnlKRW).toLocaleString())
          : red(Math.round(e.pnlKRW).toLocaleString());
      line(`   ${sign} ${e.ts}  ${e.side}/${e.reason}  ${pnl} KRW`);
    }
  }

  // 시스템/에러 로그
  const sysLog = d.systemLog ?? [];
  line(`\n⚠ 최근 이벤트/오류`);
  if (!sysLog.length) {
    line(`   - 없음`);
  } else {
    for (const evt of sysLog.slice(-5)) {
      const ts = evt.ts ?? "?";
      const msg = evt.msg ?? evt.err ?? JSON.stringify(evt);
      line(`   - ${ts}  ${msg}`);
    }
  }

  // 누적 성과
  const wr = (d.stats.winrate * 100).toFixed(1);
  const cum =
    d.stats.pnl >= 0
      ? green("+" + Math.round(d.stats.pnl).toLocaleString())
      : red(Math.round(d.stats.pnl).toLocaleString());
  line(
    `\n🏁 누적: 거래 ${d.stats.trades}건, 승 ${d.stats.wins} 패 ${d.stats.losses}, 승률 ${wr}%  |  누적 P&L ${cum} KRW\n`
  );
  if (d.daily) {
    const targetRange = `${CFG.run.targetTradesMin}-${CFG.run.targetTradesMax}`;
    const dailyPnlTxt =
      d.daily.pnl >= 0
        ? green("+" + Math.round(d.daily.pnl).toLocaleString())
        : red(Math.round(d.daily.pnl).toLocaleString());
    line(
      `   ↳ 오늘: 거래 ${d.daily.trades}건 (목표 ${targetRange}) · 승 ${d.daily.wins} 패 ${d.daily.losses} · P&L ${dailyPnlTxt} KRW`
    );
  }

  // 용어 설명
  if (d.showGlossary) out.push(...glossary(d));

  // 버퍼 비교 후 변경 시에만 출력
  const buf = out.join("\n");
  if (buf === __prevBuf) return;
  __prevBuf = buf;

  homeAndClearToEnd();
  process.stdout.write(buf + "\n");
}
