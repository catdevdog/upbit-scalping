## !100% vibe coding

# 업비트 스캘핑 자동매매 봇 v3.0

Node.js 기반 **BTC 스캘핑** 자동매매 봇.  
v3.0은 **실거래 주문 경로(JWT)**, **대시보드·용어 설명 강화**, **깜빡임 저감 렌더링**, **체결 로그 기반 통계**, **과거 시간대 분석 스크립트**를 포함합니다.

---

## 목차

INTERVAL_MS=400

- [요구 사항](#요구-사항)
- [설치](#설치)
- [환경 변수](#환경-변수)
  - [빠른 시작용 .env 예시](#빠른-시작용-env-예시)
  - [환경 변수 표](#환경-변수-표)
- [실행](#실행)
- [대시보드 가이드](#대시보드-가이드)
- [전략 상세](#전략-상세)
  - [진입 조건](#진입-조건)
- [폴더 구조](#폴더-구조)
- [v2.0 → v3.0 마이그레이션](#v20--v30-마이그레이션)
- [트러블슈팅](#트러블슈팅)
- [면책](#면책)
- [라이선스](#라이선스)

---

## 특징

- **LIVE/PAPER 모드 전환**: 실거래·모의거래 스위치
- **주문 경로**: 업비트 JWT 인증, 시장가/지정가 지원
- **확률 임계치**: \(p \ge p^\*\), 대시보드에 실시간 표기  
  \(p^\*=\frac{\text{SL}+\text{FEE}+\text{SLIP}}{\text{TP}+\text{SL}}\)
- **청산 로직**: TP/SL, 본절 이동(BE), 트레일링(TRAIL), 타임아웃
- **대시보드**: 저깜빡임 렌더링, 최근 10건 체결, 승률·누적 P&L, 용어 설명(v3.0 갱신)
- **분석 도구**: “진입 조건 최초 성립” 시간대 히스토그램(KST)

---

## 요구 사항

- Node.js **18+**
- 업비트 **API 키**(실거래 시)
- macOS/Linux/Windows(WSL 포함)

---

## 설치

```bash
npm i
cp .env.example .env
# 실거래 시 .env에 키 입력 및 PAPER=false 설정
```

---

## 환경 변수

### 빠른 시작용 .env 예시

```env
# 앱 메타
APP_NAME=업비트 스캘핑 Bot
APP_VERSION=3.0

# 실행/시장
MARKET=KRW-BTC
INTERVAL_MS=400
PAPER=true

# 전략(초단타 프리셋)
TP=0.0040
SL=0.0030
FEE=0.0010
SLIP=0.0005

ATR_PERIOD=14
ATR_P_LO=0.26
ATR_P_HI=0.85
MIN_ATR_PCT=0.055

RVOL_BASE_MIN=120
MIN_RVOL=1.6

TREND_EMA_FAST=20
TREND_EMA_SLOW=50
REQUIRE_VWAP_ABOVE=false

MAX_SPREAD_TICKS=2
MIN_IMB=0.20

TIMEOUT_SEC=35
BE_TRIGGER=0.0015
BE_OFFSET=0.0003
TRAIL_PCT=0.0016

# 로그/UI
LOG_DIR=./logs
TRADE_LOG=trades.jsonl
SHOW_GLOSSARY=true
USE_ALT_SCREEN=true
MIN_RENDER_MS=120

# 실거래 키(PAPER=false일 때 필수)
UPBIT_ACCESS_KEY=
UPBIT_SECRET_KEY=

# 분석 스크립트
ANALYZE_DAYS=14
ANALYZE_IGNORE_OB=true
ANALYZE_RPS=4
```

### 환경 변수 표

| 키                            | 설명                        | 기본값                   |
| ----------------------------- | --------------------------- | ------------------------ |
| `APP_NAME`, `APP_VERSION`     | 대시보드 타이틀             | 업비트 스캘핑 Bot, 3.0   |
| `MARKET`                      | 거래 마켓                   | `KRW-BTC`                |
| `INTERVAL_MS`                 | 루프 간격(ms)               | `400`                    |
| `PAPER`                       | 모의거래 여부               | `true`                   |
| `TP`, `SL`                    | 익절·손절(비율)             | `0.0040`, `0.0030`       |
| `FEE`, `SLIP`                 | 왕복 수수료·평균 슬리피지   | `0.0010`, `0.0005`       |
| `ATR_PERIOD`                  | ATR 기간(분)                | `14`                     |
| `ATR_P_LO`, `ATR_P_HI`        | ATR 분위수 하·상한          | `0.26`, `0.85`           |
| `MIN_ATR_PCT`                 | 최소 ATR%(절대 하한)        | `0.055`                  |
| `RVOL_BASE_MIN`               | RVOL 기준 구간(분)          | `120`                    |
| `MIN_RVOL`                    | 최소 RVOL                   | `1.6`                    |
| `TREND_EMA_FAST/SLOW`         | 5분봉 EMA 20/50             | `20`, `50`               |
| `REQUIRE_VWAP_ABOVE`          | 가격 ≥ VWAP 요구 여부       | `false`                  |
| `MAX_SPREAD_TICKS`            | 허용 스프레드 틱            | `2`                      |
| `MIN_IMB`                     | 최소 호가 불균형(매수 우위) | `0.20`                   |
| `TIMEOUT_SEC`                 | 보유 시간 제한              | `35`                     |
| `BE_TRIGGER/BE_OFFSET`        | 본절 이동 트리거·오프셋     | `0.0015`, `0.0003`       |
| `TRAIL_PCT`                   | 트레일링 폭                 | `0.0016`                 |
| `LOG_DIR`, `TRADE_LOG`        | 로그 폴더/파일명            | `./logs`, `trades.jsonl` |
| `SHOW_GLOSSARY`               | 용어 설명 표시              | `true`                   |
| `USE_ALT_SCREEN`              | 대체 화면 버퍼 사용         | `true`                   |
| `MIN_RENDER_MS`               | 최소 렌더 간격(ms)          | `120`                    |
| `UPBIT_ACCESS_KEY/SECRET_KEY` | 업비트 API 키               | 빈값                     |
| `ANALYZE_DAYS`                | 분석 일수                   | `14`                     |
| `ANALYZE_IGNORE_OB`           | 과거 분석 시 호가조건 무시  | `true`                   |
| `ANALYZE_RPS`                 | 분석 호출 RPS               | `4`                      |

---

## 실행

```bash
# 모의거래
node src/index.js

# 실거래(주의: PAPER=false 필요)
PAPER=false node src/index.js
```

---

## 대시보드 가이드

- **상태/가격**: 보유 여부, 진입가/TP/SL, 현재가
- **Trend/VWAP**: 5분 EMA20/50, VWAP, 패스/실패 표시
- **ATR/RVOL/Orderbook**: 현재 값 vs 목표치, 부족 항목 상세
- **스코어**: RSI/RVOL/Orderbook/Candle 막대 그래프
- **확률**: (p)와 (p^\*) 및 차이(±%)
- **포지션 타이머**: 보유시간, 타임아웃 잔여
- **최근 체결 10건**: 사유와 P&L
- **누적 성과**: 건수·승/패·승률·누적 P&L
- **용어 설명**: RSI, RVOL, Orderbook(imb, spreadT, b1/a1), Candle, EMA, VWAP, (p)/(p^\*), TIMEOUT 등

> 깜빡임 저감: 대체 화면 버퍼, 커서 숨김, **부분 지우기**, **프레임 최소 간격** 사용

---

## 전략 상세

### 진입 조건

기본적으로 아래 조건을 충족해야 하며, 강한 체결 신호가 감지되면 “모멘텀 오버라이드” 규칙으로 일부 필터를 건너뛸 수 있습니다.

- **기본 경로**

  1. **ATR%**: `MIN_ATR_PCT` 이상 **AND** 분위수 구간 `[ATR_P_LO, ATR_P_HI]`
  2. **RVOL**: `avg(최근 5분) / avg(최근 120분) ≥ MIN_RVOL`
  3. **추세/VWAP**: 5분봉 `EMA20 > EMA50` **AND** (옵션) `가격 ≥ VWAP`
  4. **호가창**: `imbalance ≥ MIN_IMB` **AND** `spreadTicks ≤ MAX_SPREAD_TICKS`
  5. **확률 임계**: `p ≥ p*`
     (p^\*=\frac{\text{SL}+\text{FEE}+\text{SLIP}}{\text{TP}+\text{SL}})

- **모멘텀 오버라이드**
  - `OrderbookScore ≥ 0.8` 이면서 `ATR 밴드` 또는 `RVOL ≥ 1.6`이면, 추세/VWAP 필터 없이도 진입 가능

### 청산 우선순위

1. **손절(SL)**: −0.30%
2. **익절(TP)**: +0.40%
3. **본절 이동(BE)**: +0.15% 도달 시 손절을 진입가(+0.03%) 근처로 이동
4. **트레일링(TRAIL)**: 고점 대비 −0.16% 이탈 시 청산
5. **타임아웃**: `TIMEOUT_SEC`(기본 35초) 경과 시 시장가 정리

### 운영 프로파일(권장값)

| 프로파일     | 건수/일 | 승률 목표 | MIN_ATR% | MIN_RVOL | VWAP필터 | MIN_IMB | MAX_SPREAD | p 조건        |
| ------------ | ------: | --------: | -------: | -------: | -------- | ------: | ---------: | ------------- |
| 초단타(기본) |   12–20 |    63–68% |    0.055 |      1.6 | on       |    0.20 |          2 | `p ≥ p*+0.01` |
| 보수         |    6–10 |    62–66% |     0.06 |      1.7 | on       |    0.25 |          2 | `p ≥ p*+0.03` |
| 중립         |   10–18 |    60–63% |     0.05 |      1.4 | on       |    0.18 |          3 | `p ≥ p*+0.01` |
| 공격         |   18–30 |    56–60% |     0.04 |      1.1 | off      |    0.10 |          4 | `p ≥ p*−0.01` |

---

## 과거 시간대 분석 스크립트

최근 N일 동안 “**진입 조건이 처음 성립**”한 시각의 KST 분포를 출력합니다. 레이트리밋 안전(스로틀+백오프) 버전입니다.

```bash
# 권장(호가조건 무시)
node scripts/analyze-entry-windows.js --days=14 --ignore-ob=true --rps=4
```

출력: **시간대 히스토그램(0~23시)**, **요일 분포**, **상위 시간대 Top 3**

---

## 폴더 구조

```
.
├─ src/
│  ├─ api/               # Upbit REST 어댑터(JWT 주문 등)
│  ├─ config/            # .env 로딩 및 CFG
│  ├─ core/              # 스로틀/백오프 등 코어 유틸
│  ├─ executor/          # 진입·청산(BE/Trail/Timeout)
│  ├─ monitor/           # 대시보드/로거(깜빡임 저감)
│  ├─ util/              # 수학/시간/틱 유틸
│  └─ index.js           # 메인 루프
├─ scripts/
│  └─ analyze-entry-windows.js
├─ logs/
│  └─ trades.jsonl       # 체결 로그(JSON Lines)
├─ .env.example
└─ README.md
```

---

## v2.0 → v3.0 마이그레이션

- **ENV 키 변경**

  - `STOP_LOSS_PERCENT` → `SL`
  - `QUICK_PROFIT_PERCENT` → `TP`
  - 수수료/슬리피지 → `FEE`, `SLIP`
  - `MIN_ATR_THRESHOLD` → `MIN_ATR_PCT`
  - 호가창: `MAX_SPREAD_TICKS`, `MIN_IMB` 도입

- **신규 키**

  - `ATR_P_LO`, `ATR_P_HI`, `RVOL_BASE_MIN`, `REQUIRE_VWAP_ABOVE`
  - `TIMEOUT_SEC`, `BE_TRIGGER`, `BE_OFFSET`, `TRAIL_PCT`
  - UI: `USE_ALT_SCREEN`, `MIN_RENDER_MS`, `SHOW_GLOSSARY`

- **대시보드**: 용어 설명 패널, 최근 10건, 승률/누적 P&L

---

## 트러블슈팅

- **HTTP 429**: 호출 과다. 분석시 `--rps` 낮추고, 실시간 모듈은 내부 스로틀·백오프 사용.
- **주문 401/422**: API 키 권한, IP 화이트리스트, JWT 서명(`query_hash`) 확인.
- **터미널 깜빡임**: `USE_ALT_SCREEN=true`, `MIN_RENDER_MS≥120`. 외부 터미널 권장.

---

## 면책

본 코드는 교육·연구 목적입니다. **실거래 책임은 사용자에게 있습니다.**
실거래 전 반드시 **PAPER=true**로 충분히 검증하세요.

---

## 라이선스

MIT License
