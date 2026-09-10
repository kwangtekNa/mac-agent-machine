# Step 6: ios-usage-ui

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (9.3 컨텍스트·사용량·모델, 5절 디자인·문구)
- `/docs/PROTOCOL.md` (`Session.usage/effort`, `session.usage` 이벤트, `GET /usage`, `GET /models`, `PATCH /sessions/:id`)
- `/ios/MacAgent/Features/Timeline/TimelineModel.swift`(`apply`), `TimelineView.swift`(툴바 principal 제목·부제, `SessionInfoSheet`)
- `/ios/MacAgent/Features/Settings/SettingsView.swift`
- `/ios/MacAgent/Shared/Formatters.swift` (`tokens`, `usd`, `relativeTime`)
- `/ios/MacAgent/Models/Protocol/*.swift`, `/ios/MacAgent/Networking/APIClient.swift` (step 4)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

컨텍스트 게이지, 세션 정보 시트의 사용량·모델·사고 수준, 설정의 구독 사용 한도를 만든다.

### 1. `TimelineModel`

- `apply(.sessionUsage)` → `session?.usage` 갱신(세션이 없으면 보관했다가 스냅샷 후 적용). `session.snapshot`/REST 상세의 `session.usage`도 반영.
- `func setModel(_:) async`, `func setEffort(_:) async`: `PATCH` 후 응답 Session으로 교체. 실패는 `transientError`.
- `var contextUsage: ContextUsage?`, `var contextTint: Color`(60% 미만 기본 tint, 60 이상 `.yellow`, 85 이상 `.red`) — 색 판정은 `UsageLevel.tint(percent:)` 정적 함수로 분리(테스트).
- `models: [ModelOption]` 로드(`client.models(agent:)`, 시트 열 때 1회, 5분 캐시).

### 2. 컨텍스트 게이지 (`TimelineView` 툴바 principal)

- 부제 줄: `usage.context`가 있으면 `컨텍스트 21% · 42k/200k`(`Formatters.tokens`), 없으면 기존 상태 텍스트. 부제 아래 높이 3pt `ProgressView(value:)`(`.tint(contextTint)`, 폭은 제목 폭). `waiting_approval`/`error` 상태 텍스트는 컨텍스트보다 우선(상태가 idle/running일 때만 컨텍스트 표시).
- principal 영역 탭 → 세션 정보 시트.

### 3. 세션 정보 시트 (`Features/Timeline/SessionInfoSheet.swift`)

`Form` 섹션 순서: 세션(기존 cwd/agent/nativeId/생성 시각) → **사용량**(입력·출력·캐시 읽기·캐시 쓰기 토큰, 비용(`null`이면 "구독 요금제라 표시 안 함"), 턴 수, 컨텍스트 `42k / 200k (21%)` + ProgressView, 마지막 갱신 상대 시간; `usage == nil`이면 "아직 사용량이 없습니다") → **모델**(`Picker` from `models`, 현재 `session.model`을 선택. 목록에 없는 현재 값은 "현재: <id>" 행으로 표시. 변경 → `setModel`) → **사고 수준**(선택 모델의 `efforts`가 비어 있지 않을 때만, `Picker`, 변경 → `setEffort`, 캡션 "다음 턴부터 적용됩니다") → **구독 한도**(`client.usage()`에서 이 에이전트의 한도 요약 최대 2줄: `5시간 42% · 3시간 후 초기화`, 링크 "설정에서 자세히") → 기존 "세션 닫기".

### 4. 설정 > 구독 사용 한도 (`Features/Settings/UsageLimitsView.swift`)

- `SettingsView`에 섹션 "구독 사용 한도" → `NavigationLink("사용 한도 보기")` + 인라인 요약(에이전트별 가장 높은 `usedPercent` 한 줄).
- `UsageLimitsView`: 에이전트별 카드(`Section`): 헤더 "Claude Code · Max"(plan 없으면 이름만), 각 한도 행 = 라벨 + `ProgressView(value:)` + `42% · 3시간 후 초기화`(`resetsAt` 없으면 생략). 색: `warning` `.yellow`, `exceeded` `.red` + 캡션 "한도 도달". Claude(`live: false`) 카드 하단 캡션 "마지막 관측 HH:mm · 세션을 실행하면 갱신됩니다", `observedAt == nil`이면 "아직 관측되지 않았습니다". Codex(`live: true`) 툴바 새로고침 버튼. 등장 시 1회 로드, 60초마다 갱신(사라지면 중단), `refreshable`.
- `UsageLimitsModel`(@Observable): `load()`, `agents`, `errorMessage`, `lastLoadedAt`.

### 5. Formatters

`tokens(_:)`가 1.2k/3.4M 형식인지 확인하고 `contextLine(tokens:window:percent:)`, `resetLine(usedPercent:resetsAt:)`(상대 시간: "3시간 후", "내일 09:00") 추가.

### 6. 테스트

- `TimelineModelUsageTests`: `session.usage` 이벤트 적용, 스냅샷 전 도착 보관, `UsageLevel.tint` 경계(59/60/84/85), `setModel/setEffort` PATCH 본문과 응답 반영, 실패 시 transientError.
- `UsageLimitsModelTests`: fixture `rest/usage.json`으로 로드, warning/exceeded 분류, 60초 갱신 타이머(주입), 실패 메시지.
- `FormattersTests` 확장: contextLine, resetLine.
- 시트/뷰 로직은 상태 객체로 분리해 테스트(모델 목록에 없는 현재 값 처리, efforts 빈 배열이면 섹션 숨김).

### 7. 수동 확인

개발 서버(Fake는 usage를 낸다)에서: 세션에 "hello" 두 번 → 게이지 %가 오르고 시트의 토큰·턴 수가 늘어남 → 모델 `fake-mini` 선택 시 사고 수준 섹션이 사라짐 → 설정 > 사용 한도에서 `seven_day 81%`가 노란색. 스크린샷을 찍어 9.3과 비교하라.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Settings/UsageLimitsView.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 9.3의 위치·색 규칙·문구를 그대로 따르는가? 시스템 색만 썼는가?
   - 이벤트 적용이 `TimelineModel.apply` 한 곳인가? 낙관적 갱신 없이 PATCH 응답으로 교체하는가?
   - `live: false` 표기가 Claude 카드에 있는가(사용자가 최신값으로 오해하지 않게)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 비용을 청구 금액처럼 단정하는 문구를 쓰지 마라("추정"을 붙인다).
- 앱이 직접 Anthropic/OpenAI API를 호출하지 마라. 모든 값은 서버에서.
- 세션 홈 목록에 게이지를 추가하지 마라(범위 밖, 목록이 무거워진다).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
