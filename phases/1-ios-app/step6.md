# Step 6: approvals-ui

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (1절, 5.3 승인 배너 규격, 6절, 7절 다중 승인·다른 클라이언트 처리)
- `/docs/PROTOCOL.md` (3절 Approval: `options`, `inputFields`, `diff`; 2절 `approval.respond`; 1절 `POST /sessions/:id/approvals/:approvalId`)
- `/docs/ARCHITECTURE.md` (7절 권한 요청 데이터 흐름)
- `/packages/protocol/fixtures/ws/approval.requested.*.json` (4종: command, file_change, permission, user_input)
- `/ios/MacAgent/Features/Timeline/TimelineModel.swift`, `TimelineView.swift`, `Cards/ApprovalCard.swift` (step 5)
- `/ios/MacAgent/Shared/DiffTextView.swift`, `Haptics.swift`(있으면) (step 5)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

이 앱에서 기억에 남아야 할 단 하나의 요소, 승인 배너를 만든다. 배너·상세 시트·입력 폼·응답 전송·다른 클라이언트가 처리했을 때의 정리·햅틱까지.

### 1. `TimelineModel` 확장

```swift
enum ApprovalSubmitState: Equatable { case idle, submitting(approvalId: String), failed(approvalId: String, message: String) }
private(set) var approvalSubmit: ApprovalSubmitState
func respond(to approval: Approval, optionId: String, inputs: [String: String]? = nil, message: String? = nil) async
```

- 소켓이 `.open`이면 `approval.respond`를 소켓으로, 아니면 REST `respondApproval`로 보낸다. 전송 중에는 해당 승인의 버튼을 비활성(`submitting`). 확정은 서버의 `approval.resolved` 이벤트다. 낙관적으로 pending에서 제거하지 않는다.
- 409(이미 처리됨)나 소켓 `error`가 오면 `failed`로 두고 메시지 "이미 처리된 요청입니다"를 2초 표시한 뒤 pending에서 제거(서버 상태와 맞춘다: `refreshDetail()`로 `GET /sessions/:id` 재조회).
- `approval.requested`가 도착하면 `Haptics.warning()` 1회(`UINotificationFeedbackGenerator`). 재생(스냅샷·since 재접속)으로 들어온 요청에는 햅틱을 울리지 않는다(`isReplaying` 플래그: snapshot 처리 직후부터 첫 라이브 이벤트 전까지).

### 2. `ios/MacAgent/Features/Approvals/ApprovalBanner.swift`

`docs/IOS.md` 5.3 규격 그대로:

- `pendingApprovals`가 비어 있지 않을 때만 컴포저 위 슬롯에 표시(step 5의 `ApprovalBannerSlot` 교체). 가장 오래된 승인 하나를 보여주고, 2건 이상이면 오른쪽 위에 "외 N건" 캡션(탭 → `PendingApprovalsSheet`).
- 배경 `Color.yellow.opacity(0.18)`, 왼쪽 `hand.raised.fill`(`.yellow`), 제목 굵게(`approval.title`), 그 아래 `prompt` 한 줄(말줄임), `kind`별 보조 정보: `command`는 `detail`의 첫 `$` 줄을 monospaced 캡션으로, `file_change`는 파일 수, `permission`은 "권한 요청", `user_input`은 "질문 N개".
- 버튼: `options` 순서대로. `style` 매핑 primary → `.borderedProminent`, secondary → `.bordered`, destructive → `.bordered` + `.tint(.red)`. 3개 초과면 처음 2개 + "더 보기"(시트). `user_input`은 버튼 대신 "답변하기" 하나(시트).
- 배너 전체 탭 → `ApprovalSheet`. 등장 애니메이션은 아래에서 올라오는 `.transition(.move(edge: .bottom).combined(with: .opacity))` 1회, `accessibilityReduceMotion`이면 없음. 사라질 때는 즉시.
- `approval.resolved`(누가 처리했든)로 pending에서 빠지면 배너가 즉시 사라진다.

### 3. `ApprovalSheet.swift`

`NavigationStack` 안 `Form`:

- 헤더: kind 아이콘, `title`, `prompt`.
- "내용": `detail`을 monospaced로(선택 가능). `diff`가 있으면 `DiffTextView`(높이 제한 없이 시트 안에서 스크롤).
- `user_input`: `inputFields`마다 `text` → `TextField`, `secret` → `SecureField`, `choice` → `Picker`(choices). 필수 입력이 비어 있으면 "보내기" 비활성.
- 거절 사유: "거절" 계열(`deny`, `abort`)을 누르면 선택적 사유 `TextField("사유(선택)")`가 펼쳐지고 확인 버튼. 사유는 `message`로 전송.
- 하단 버튼 영역: 옵션 전부(스타일 매핑 동일). `submitting` 중 `ProgressView`.
- 처리되면(`pending`에서 빠지면) 시트 자동 닫힘.

### 4. `PendingApprovalsSheet.swift`

대기 중 승인 목록(오래된 순). 각 행 탭 → `ApprovalSheet`. 각 행에 빠른 "허용"/"거절" 버튼은 넣지 않는다(실수 방지).

### 5. `ApprovalCard`(타임라인) 연결

step 5의 읽기 전용 카드에서 대기 중 카드의 "아래 배너에서 응답하세요" 캡션을 "자세히 보기" 버튼(시트)으로 바꾼다. 카드 자체에는 허용/거절 버튼을 두지 않는다(배너가 유일한 빠른 응답 지점).

### 6. 세션 밖 알림(앱 내)

세션 홈에 있는 동안 다른 세션에 승인이 오는 것은 step 4의 15초 폴링 배지로만 알린다. 이 step에서는 `SessionsHomeView` 상단에 `pendingApprovalTotal > 0`이면 노란 요약 행 "승인 대기 N건 · 탭하여 이동"(가장 오래된 대기 세션으로 push)을 추가한다. 백그라운드 푸시는 Phase 3.

### 7. 테스트 (`ios/MacAgentTests/Features/Approvals/`)

- `ApprovalBannerLogicTests.swift`(뷰에서 분리한 `ApprovalBannerState.make(pending:)`): 가장 오래된 선택, "외 N건", 옵션 3개 초과 시 절단, `user_input`은 답변하기 1개, 스타일 매핑.
- `TimelineModelApprovalTests.swift`: `respond`가 소켓 open이면 `approval.respond` 메시지(approvalId, optionId, inputs, message 포함)를 보내고, 아니면 REST를 호출; `submitting` → `approval.resolved` 수신 → pending 제거·idle; 409 → failed → refreshDetail 호출; 재생 이벤트에는 햅틱 없음(`Haptics`를 프로토콜로 주입해 호출 횟수 검증); 다른 클라이언트의 `approval.resolved`로 pending 제거.
- `ApprovalSheetFormTests.swift`(폼 검증 로직): 필수 입력 비어 있으면 제출 불가, choice 기본값.

### 8. 수동 확인

개발 서버(`bash scripts/dev-smoke.sh --keep`)에서 새 세션 → "hello" → 배너 등장(햅틱은 시뮬레이터에서 안 울린다) → "이 세션에서 항상 허용" 탭 → 배너 사라지고 카드가 "항상 허용됨"으로, tool_call 완료, turn_summary. 두 번째 세션에서 승인이 대기 중일 때 세션 홈의 요약 행과 배지를 확인. 스크린샷을 찍어 5.3 규격과 비교하라.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 5.3 배너 규격(배경, 아이콘, 버튼 스타일, 3개 초과 규칙, 애니메이션 1회)을 그대로 따르는가?
   - 응답 확정이 서버의 `approval.resolved`에만 의존하고 낙관적 제거가 없는가?
   - 자동 만료·자동 허용 로직이 없는가(ARCHITECTURE 2.4: 자동 만료 없음)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- "모두 허용" 같은 일괄 승인 버튼을 만들지 마라. 이유: 승인은 건별 판단이다. `allow_session`은 어댑터가 옵션으로 줄 때만 노출한다.
- 로컬 알림(`UNUserNotificationCenter`)이나 백그라운드 fetch를 넣지 마라. 이유: 백그라운드에서는 소켓이 없어 의미가 없고, 진짜 푸시는 Phase 3(APNs)이다.
- 배너를 화면 상단이나 세션 홈에 띄우지 마라. 위치는 컴포저 위 하나다(한 손 조작).
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
