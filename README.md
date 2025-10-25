# 업비트 자동매매 프로그램

업비트 API와 Node.js를 이용한 적응형 암호화폐 자동매매 봇입니다.

## 주요 기능

- ✅ **8가지 매매 전략** (이동평균, 볼린저밴드, RSI, 변동성 돌파, 거래량, 호가창, 지지/저항, 캔들 패턴)
- ✅ **적응형 전략 조정** (거래 성과에 따라 방어적 ↔ 공격적 자동 전환)
- ✅ **자동 손절/익절** (설정 가능한 비율)
- ✅ **추가 매수 지원** (물타기)
- ✅ **전액 무한 매매** (가용 잔고 최대 활용)
- ✅ **비상 정지 시스템** (급락, 네트워크 장애 감지)
- ✅ **상태 저장/복구** (프로그램 재시작 시 이전 상태 복구)
- ✅ **거래 기록 및 성과 추적**

## 설치 방법

### 1. 저장소 클론 및 의존성 설치

```bash
git clone <repository-url>
cd upbit-auto-trader
npm install
```

### 2. 환경 변수 설정

`.env.example` 파일을 `.env`로 복사하고 내용을 수정합니다.

```bash
cp .env.example .env
```

필수 설정:

- `UPBIT_ACCESS_KEY`: 업비트 API Access Key
- `UPBIT_SECRET_KEY`: 업비트 API Secret Key
- `MARKET`: 거래할 마켓 (예: KRW-BTC)

### 3. 업비트 API 키 발급

1. [업비트](https://upbit.com) 로그인
2. 마이페이지 > Open API 관리
3. API 키 발급 (자산조회, 주문조회, 주문하기 권한 필요)

⚠️ **주의**: IP 주소 제한을 설정하여 보안을 강화하세요.

## 실행 방법

### 개발 모드 (nodemon)

```bash
npm run dev
```

### 프로덕션 모드

```bash
npm start
```

### 종료

`Ctrl + C`를 눌러 안전하게 종료합니다. 현재 상태가 자동 저장됩니다.

## 설정 가이드

### 전략 모드 설정

```bash
STRATEGY_MODE=auto  # auto/defensive/neutral/aggressive
```

- **auto**: 거래 성과에 따라 자동 조정
- **defensive**: 방어적 (높은 점수 + 다수 신호 필요)
- **neutral**: 중립적 (중간 점수 + 일부 신호)
- **aggressive**: 공격적 (낮은 점수만으로도 진입)

### 전략 활성화/비활성화

원하는 전략만 활성화할 수 있습니다:

```bash
STRATEGY_MA=true          # 이동평균선
STRATEGY_BB=true          # 볼린저밴드
STRATEGY_RSI=true         # RSI
STRATEGY_VOLATILITY=false # 변동성 돌파
STRATEGY_VOLUME=true      # 거래량 분석
STRATEGY_ORDERBOOK=false  # 호가창 분석
STRATEGY_SUPPORT=false    # 지지/저항선
STRATEGY_CANDLE=false     # 캔들 패턴
```

### 손절/익절 설정

```bash
STOP_LOSS_PERCENT=-5.0      # -5% 손절
TAKE_PROFIT_PERCENT=10.0    # +10% 익절
TRAILING_STOP_ENABLED=false # 트레일링 스탑
```

### 자동 전략 조정 설정

```bash
AUTO_ADJUST_ENABLED=true           # 자동 조정 활성화
ADJUST_CHECK_TRADE_COUNT=10        # 10회 거래마다 재평가
PROFIT_THRESHOLD_AGGRESSIVE=3.0    # 평균 3% 이상 → 공격적
PROFIT_THRESHOLD_NEUTRAL=1.0       # 평균 1~3% → 중립적
# 1% 미만 → 방어적
```

## 파일 구조

```
upbit-auto-trader/
├── src/
│   ├── index.js                  # 메인 실행 파일
│   ├── config/env.js             # 환경 설정
│   ├── api/                      # 업비트 API
│   ├── strategies/               # 매매 전략들
│   ├── trading/                  # 거래 실행 로직
│   ├── logger/                   # 로깅 및 성과 추적
│   ├── monitor/                  # 비상 정지
│   └── utils/                    # 유틸리티
└── logs/
    ├── state.json                # 현재 상태
    ├── trades.json               # 거래 기록
    └── performance.json          # 성과 기록
```

## 매매 전략 설명

### 1. 이동평균선 (MA)

- 5일/20일/60일 이동평균선 활용
- 정배열, 골든크로스 감지

### 2. 볼린저밴드 (BB)

- 하단 밴드 터치 후 반등 포착
- 과매도 구간에서 진입

### 3. RSI

- 과매도(30 이하) 구간 감지
- 중립선(50) 돌파 확인

### 4. 변동성 돌파

- Larry Williams의 변동성 돌파 전략
- 전일 변동폭 기반 목표가 계산

### 5. 거래량 분석

- 평균 대비 급증 감지
- 가격 상승과 동반 여부 확인

### 6. 호가창 분석

- 매수/매도 호가 불균형 감지
- 매수 압력 우세 시 진입

### 7. 지지/저항선

- 과거 고점/저점 분석
- 지지선 반등, 저항선 돌파 포착

### 8. 캔들 패턴

- 연속 양봉 패턴 감지
- 급등 발생 포착

## 로그 파일 설명

### logs/state.json

현재 프로그램 상태 (포지션, 전략 모드 등)

### logs/trades.json

모든 거래 내역 (매수/매도가, 손익, 보유시간 등)

### logs/performance.json

성과 요약 (승률, 평균 수익률, 총 수익 등)

## 안전 기능

### 1. 비상 정지 시스템

- 급락 감지 (기본값: -15%)
- 네트워크 타임아웃 (기본값: 30초)
- 연속 API 에러 (기본값: 10회)

### 2. 재시도 로직

- API 호출 실패 시 무한 재시도
- 지수 백오프 적용

### 3. 상태 저장/복구

- 프로그램 종료 시 자동 저장
- 재시작 시 이전 포지션 복구

## 주의사항

⚠️ **투자 위험 고지**

- 암호화폐 투자는 고위험 투자이며 원금 손실 가능성이 있습니다.
- 본 프로그램은 투자 손실에 대한 책임을 지지 않습니다.
- 소액으로 충분히 테스트 후 사용하세요.

⚠️ **기술적 주의사항**

- API 호출 제한: 초당 10회, 분당 600회
- 최소 주문 금액: 5,000원
- 프로그램을 여러 개 동시 실행하지 마세요.
- 업비트 점검 시간에는 사용할 수 없습니다.

## 트러블슈팅

### "잔고 부족" 에러

- KRW 잔고를 확인하세요.
- `MIN_KRW_RESERVE` 설정을 낮추세요.

### API 호출 실패

- API 키가 올바른지 확인하세요.
- 네트워크 연결을 확인하세요.
- 업비트 서버 상태를 확인하세요.

### 프로그램이 멈춤

- `logs/state.json`을 확인하여 비상 정지 사유를 확인하세요.
- 네트워크 상태를 확인하세요.

## 개선 아이디어

- [ ] Telegram 알림 추가
- [ ] 웹 대시보드 구현
- [ ] 백테스팅 기능
- [ ] 다중 마켓 지원
- [ ] 기계학습 모델 통합

## 라이선스

MIT License

## 기여

이슈 및 Pull Request는 언제나 환영합니다!
