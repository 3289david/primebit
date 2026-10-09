# PrimeBIT 코인 환전소 (디스코드 봇)

원화 충전 → 입금 자동인식 → 포인트 지급 → 코인 구매 시 내 지갑에서 유저 지갑으로 자동 송금 → 블록 확정 후 DM.

```
유저 ─(충전 신청: 입금자명+금액)─▶ 봇이 입금계좌 안내
유저 ─(관리자 계좌로 송금)─▶ 은행 문자/푸시 ─▶ [안드로이드 앱] ─(HMAC 서명)─▶ POST /api/deposit
                                                       이름+금액 일치 ▶ 포인트 100% 지급 + DM
유저 ─(코인 구매: 코인·주소·포인트)─▶ 수수료 3% 공제 → 나머지 97%치 코인 ─▶ 핫월렛이 유저 주소로 송금
                                      └▶ 전송됨(DM) → 블록 확정 감시(15초 주기) → 확정 시 DM + 탐색기 링크
```

## 지원 체인 / 코인 (12체인 · 21종)
| 체인 | 코인 | 핫월렛 키 |
|---|---|---|
| TRON | TRX, USDT-TRC20 | `TRON_PRIVATE_KEY` |
| Ethereum | ETH, USDT-ERC20, USDC-ERC20 | `EVM_PRIVATE_KEY` |
| BNB Smart Chain | BNB, USDT-BEP20 | `EVM_PRIVATE_KEY` |
| Polygon | POL, USDT-POLYGON | `EVM_PRIVATE_KEY` |
| Avalanche C-Chain | AVAX | `EVM_PRIVATE_KEY` |
| Arbitrum / Optimism / Base / Linea | ETH-ARB, USDT-ARB / ETH-OP / ETH-BASE, USDC-BASE / ETH-LINEA | `EVM_PRIVATE_KEY` |
| Solana | SOL, USDT-SOL, USDC-SOL | `SOL_PRIVATE_KEY` |
| XRP Ledger | XRP (`r주소:데스티네이션태그` 지원) | `XRP_SEED` |
| Bitcoin | BTC (P2WPKH, mempool.space API) | `BTC_WIF` |

- **키를 설정한 체인의 코인만** 판매 목록에 나타납니다. (EVM 8개 체인은 키 하나, 주소 하나 공유)
- 코인 추가는 [src/chains/config.js](src/chains/config.js) 의 `COINS` 에 한 줄 (EVM 토큰은 컨트랙트 주소만).
- 시세: 업비트 KRW 마켓 (BNB는 코인베이스 달러가 × 업비트 USDT 원화가)

## 기능
- **유저(디스코드)**: 충전 / 코인 구매 / 매입 신청 / 내 정보 / 내역 / 계산기 / 문의 티켓 · 지난번 주소 자동 입력 · 견적 60초 확정 단계
- **자동 DM**: 충전 완료·만료 / 코인 전송 시작 / 블록 확정(탐색기 링크) / 주문 문제 발생 / 환불 / 포인트 조정 / 매입 처리 / 이용 제한·해제
- **현황**: 임베드(30초 갱신) + 음성채널 시세판(환율·김프·주요 재고, 6분 갱신) + 재고 부족/재입고/수수료(가스) 부족 알림(충전 주소 포함) + 공개 거래 로그(이름 마스킹)
- **관리자 패널** `https://primebit.krl.kr/admin` (디스코드 OAuth 로그인)
  - 대시보드: 총 재고 가치, 오늘/누적 수수료 수익, 7일 그래프, 점검 모드, 디스코드 공지, CSV 내보내기
  - **재고/지갑**: 체인별 **재고 충전 주소(복사)**, 코인별 재고·시세·가치·상태, **보충 권장 수량**, 가스 잔액 경고, 코인별 판매 중지/재개
  - 충전·입금(미매칭 수동 매칭)·주문(탐색기 링크, 재전송/환불)·매입·유저(포인트 조정/차단)·포인트 로그·**감사 로그**·설정
- **안전장치**: 1인 1일 구매 한도, 점검 모드, 송금 체인별 직렬 처리, 실패 시 자동 재전송/환불 없이 `error` 보관(이중 송금 방지)

## 설치
1. 디스코드 개발자 포털
   - **Bot**: 토큰 발급 → 서버에 초대 (권한: 채널 관리, 역할 관리, 메시지 전송, 임베드)
   - **OAuth2**: Client ID/Secret 확인, Redirects 에 `https://primebit.krl.kr/admin/callback` 추가
2. `.env.example` → `.env` 복사 후 값 채우기 (`ADMIN_DISCORD_IDS` 에 본인 디스코드 ID)
3. 도메인/HTTPS: `primebit.krl.kr` DNS A 레코드를 서버 IP로, [deploy/Caddyfile](deploy/Caddyfile) 로 Caddy 실행 (인증서 자동)
4. 실행
   ```bash
   npm install
   npm run check:chains -- --probe   # RPC/토큰 컨트랙트 점검 (읽기 전용)
   npm start
   ```
5. 디스코드에서 관리자 계정으로: `/setup panel`, `/setup status`, `/setup voice`
6. 관리자 패널 접속 → **설정 탭에서 입금 계좌 입력** → **재고/지갑 탭의 주소로 코인 입금**(가스용 네이티브 코인 포함)

### 관리자 로그인
비밀번호 로그인은 없습니다. 디스코드 OAuth 로 로그인하며, `ADMIN_DISCORD_IDS` 에 있거나 서버에서 `ADMIN_ROLE_ID` 역할을 가진 계정만 통과합니다. 모든 변경 작업은 감사 로그에 기록됩니다.

## 안드로이드 입금감지 앱
`android/` 를 Android Studio 로 열어 빌드 → 입금 문자를 받는 폰에 설치.
1. 서버 주소 `https://primebit.krl.kr` 과 `DEVICE_SECRET` 입력 → 저장
2. 알림 접근 권한 · 문자 수신 권한 · 배터리 최적화 제외
3. "서버 연결 테스트"
- 서버는 **입금자명 + 금액이 모두 일치**하는 대기 중 충전만 자동 지급. 불일치는 패널 > 입금내역에서 수동 매칭
- 전송 실패 시 폰에 큐로 보관 후 재시도, 서버는 해시로 중복 제거

## 테스트 / 점검
```bash
npm test                          # 24개: 입금·충전·주문·확정·OAuth·CSRF·체인 어댑터(주소 파생/검증, BTC 서명)
npm run check:chains              # 설정된 핫월렛 잔액·RPC·컨트랙트 점검
```
제품 코드에는 시뮬레이션/가짜 모드가 없습니다. 테스트는 임시 DB와 체인 어댑터 스텁만 사용합니다.

## 운영 전 꼭 확인
- **개인키는 `.env` 에 평문 저장됩니다.** 소액만 두고, 서버 접근을 통제하세요. 처음에는 **소액으로 체인별 1건씩 실전송 테스트**를 권장합니다.
- 체인별 수수료용 네이티브 코인(TRX/ETH/BNB/POL/AVAX/SOL/XRP)과 BTC 확정 UTXO가 있어야 송금됩니다.
- 공용 RPC는 제한/불안정할 수 있어 운영에서는 전용 RPC(`RPC_*`)를 권장합니다.
- Solana/XRP는 전송 후 일정 시간 원장에 안 보이면 `error`(드롭 추정)로 표시합니다. 탐색기에서 미전송을 확인한 뒤 재전송하세요.
- 법률: 원화↔가상자산 교환 영업은 **가상자산사업자(VASP) 신고·AML(특금법)** 대상일 수 있습니다.

