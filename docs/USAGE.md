# 사용 가이드 (쉬운 버전)

이 문서는 현재 프로젝트를 **처음 실행하는 사람**을 위한 간단 가이드입니다.

## 1) 준비

- Node.js 18+ 설치
- .env 확인

필수:

- MARKET, PAPER, LOG_DIR, TRADE_LOG
- ML_MODEL_PATH, ML_MODEL_PATH_OB

권장:

- ML_AUTO_RETRAIN=true (자동 재학습)
- ML_USE_OB_FEATURES=true (오더북 피처 사용)
- ML_OB_REQUIRED=true (오더북 필터 강제)

## 2) 실행 순서 (처음 1회)

1. 과거 데이터 수집

- npm run backfill:candles

2. 모델 학습

- 캔들 모델: npm run train:ml
- 오더북 포함 모델: npm run train:ml:trades

3. 봇 실행

- npm start

## 3) 자동 재학습

- 기본: 24시간마다 자동 재학습
- 백필 기간: 최근 7일
- 변경은 .env에서 설정

## 4) 신호 판단 방식 요약

- ML 확률이 기준 이상이면 진입
- 오더북이 나쁘면 진입 차단
- ATR%로 TP/SL을 자동 조절
- 확률/기대값에 따라 진입 금액 조절

## 5) 문제가 생겼을 때

- “ML 모델 없음”이면 train:ml 또는 train:ml:trades 실행
- “ML 피처 부족”이면 backfill:candles 실행
- 과도한 진입/손실이면 ML_MIN_PROB, ML_TP_ATR_MULT, ML_SL_ATR_MULT 조정

## 6) 추천 기본값 (안정형)

- ML_MIN_PROB=0.60
- ML_TP_ATR_MULT=2.0
- ML_SL_ATR_MULT=2.6
- ML_OB_REQUIRED=true
- ML_USE_OB_FEATURES=true

## 7) 로그 확인

- 거래 로그: logs/trades_intraday.jsonl
- 캔들 백필: logs/candles_1m.jsonl
- ML 모델: logs/ml_model.json, logs/ml_model_ob.json
