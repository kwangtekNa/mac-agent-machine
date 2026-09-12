# Step 5: rooms-list-and-room-screen

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` 4절(compact/iPad 3열), 5.1~5.5, 6절, 9.1(세그먼트는 바깥 NavigationStack 안에서 제자리 탐색 — 중첩 NavigationStack 금지의 교훈)
- `/docs/PROTOCOL.md` 6.3, 6.4
- `/ios/MacAgent/Features/Timeline/TimelineView.swift`(`TimelineScreen`: 스크롤 바닥 앵커·"새 이벤트" 칩·`safeAreaInset` 배너+컴포저·`scenePhase` 처리·툴바), `Composer.swift`, `Cards/AssistantMessageCard.swift`(Markdown + `Theme.macAgent`, 50ms 디바운스), `Cards/UserMessageCard.swift`, `Cards/SystemRow.swift`, `Cards/ItemCard.swift`(step 3 의 `CardChrome`)
- `/ios/MacAgent/Features/Approvals/ApprovalBanner.swift` (step 3: `any ApprovalResponding`)
- `/ios/MacAgent/Features/Rooms/RoomModel.swift`, `RoomEntry.swift`, `MentionParser.swift` (step 2), `/ios/MacAgent/Features/Teams/*.swift` (step 4), `/ios/MacAgent/App/AppState.swift`(`roomModel`, `selectedRoom`), `App/SplitRootView.swift`
- `/ios/MacAgent/Shared/ItemStyle.swift`, `Formatters.swift`, `Haptics.swift`

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

방 목록과 방 화면을 만든다. 작업 요약·승인·변경 카드는 step 6 이 붙이므로 이 step 에서는 그 자리에 최소 placeholder(한 줄 텍스트)를 둔다.

### 확정된 결정

- 작업 중 표시: 메시지 목록 끝에 **임시 말풍선** "🧑‍💻 지연이 작업 중…"(대기 중이면 "대기 중"), 컴포저 위에 **상태 줄**("지연 작업 중 · 민수 대기 중"). 답변이 오면 말풍선은 사라진다. 방 목록의 팀원 행에는 상태 점.
- 그룹방에서 멘션 없이 입력 중이면 컴포저 위 캡션 "팀장 민수에게 전달됩니다". DM 에서는 캡션 없음.
- 메시지를 **길게 누르면** 컨텍스트 메뉴: 에이전트 메시지 "@지연에게 답장"(컴포저에 `@지연 ` 삽입), 모든 메시지 "복사".
- 컴포저는 텍스트 끝의 `@토큰` 으로 팀원 제안 칩(`MentionParser.suggestions`)을 보이고, 칩을 탭하면 `MentionParser.apply`.
- iPad 3열: 사이드바에 팀 섹션, 방을 고르면 content 열에 `RoomView`, detail 열은 **팀원 타임라인**(작업 요약 카드에서 고른 팀원, 고르기 전에는 팀원 목록: 상태·브랜치).
- 답변은 턴이 끝난 뒤 한 번에 온다(스트리밍 없음). 정지 버튼 대신 상태 줄에 "중단"(팀 전체 `interrupt`) 버튼.

### 1. `Features/Teams/TeamRoomsView.swift`

- `Team` 을 받아 `List`: `#전체` 행(마지막 메시지 시각) + 팀원별 DM 행(`MemberChip` + `MemberStatusDot` + 팀장이면 "팀장" 캡션). 탭 → `RoomView`(같은 스택에서 push, `NavigationLink(value: RoomRef)` 로 `RoomRef: Hashable { teamId, roomId }`).
- 툴바: 팀 설정(`TeamSettingsView`, step 4), "작업 전부 중단". 상태는 `TeamsStore` + `SessionsStore` 조인(`MemberStatus.status`) 으로, 방을 열지 않아도 보이게.
- 식별자 `rooms.group`, `rooms.dm.<memberId>`.

### 2. `Features/Rooms/RoomView.swift`

- `TimelineScreen` 과 같은 골격: `ScrollViewReader` + `LazyVStack(spacing: 12)` + 바닥 앵커 + "새 메시지" 칩, `safeAreaInset(edge: .bottom)` 에 `ApprovalBanner(model: roomModel)` + 상태 줄 + 캡션 + `RoomComposer`. `.task { await model.start() }`, `.onDisappear { model.stop() }`, `scenePhase` 처리는 `TimelineScreen` 과 동일하게 복사.
- 항목 렌더(`RoomEntryRow`): `.message` 사용자 → `MessageCard(.user)`, 에이전트 → `MessageCard(.agent)`, `.system` → `SystemRow` 스타일 한 줄, `.approval`/`.changes` → step 6 전까지 placeholder(`ItemCard(chrome:…)` 에 `message.text` 한 줄).
- 임시 말풍선: `model.workingMembers`/`queuedMembers` 로 목록 끝에 `WorkingBubble`(`ProgressView` mini + "지연이 작업 중…").
- 툴바 principal: 방 이름(`#전체` 또는 팀원 `MemberChip`) + 부제(팀 이름). trailing: 팀원 목록 시트(상태·브랜치, 팀원 타임라인 열기), iPad 가 아니면 "설정".
- 오류: `fatalError` 배너(TimelineScreen 과 같은 모양), `transientError` 는 컴포저 위 캡션 자리에 잠깐.
- `RoomModel` 은 `appState.roomModel(for:roomId:client:)` 로 얻는다(회전·재진입에도 유지).

### 3. `Features/Rooms/RoomComposer.swift`

- `TextField(axis: .vertical)` 1~6줄, 보내기 버튼(`arrow.up.circle.fill`), 정지 버튼 없음. 식별자 `room.composer.input`, `room.composer.send`.
- 위에 제안 칩 행(`MemberChip` 축소형, 식별자 `room.mention.<memberId>`), 그 위에 캡션(그룹방·멘션 없음·텍스트 비어있지 않음 → "팀장 <이름>에게 전달됩니다"; 알 수 없는 `@토큰` 이 있으면 "모르는 팀원 @xxx 는 무시됩니다").
- 외부에서 텍스트 삽입(`@이름 ` 답장)을 받을 수 있게 `insertRequest` 바인딩.
- 보내면 `model.send(text:)`, 성공 시 비움(서버 에코를 기다린다).

### 4. 카드·공용 컴포넌트

- `Features/Rooms/Cards/MessageCard.swift`: 사용자 = `UserMessageCard` 와 같은 accent 10% 배경, 에이전트 = 상단 `MemberChip` + `Markdown(text).markdownTheme(Theme.macAgent(dimmed: false))` + `.textSelection(.enabled)`; 오른쪽 위 시각(`Formatters.clock`). `contextMenu` 로 "@이름에게 답장"/"복사". 접근성 라벨 "지연(개발자): <본문>".
- `Shared/MemberAvatar.swift`: `MemberAvatar(member:size:)`(이모지 in `Circle`, `Color(.tertiarySystemGroupedBackground)`), `RoleBadge(label:)`(캡슐, `.caption2`), `MemberChip(member:)`(아바타 + 이름 + 역할 배지 + Claude/Codex 캡션), `MemberStatusDot(state:)`(idle 회색, queued 노랑 테두리, running 파랑 `ProgressView` mini, waitingApproval 노랑, error 빨강 — 시스템 색만, 아이콘 동반).
- `ItemStyle.swift` 에 방 항목용 `static func roomStyle(for entry: RoomEntry) -> ItemStyle`(system 은 `info.circle .secondary` 등).

### 5. iPad

`SplitRootView`: 사이드바에 "팀" 섹션(`TeamRow`), 팀을 고르면 사이드바 아래에 방 목록을 펼치거나(`DisclosureGroup`) content 열에 `TeamRoomsView` → 방 선택 시 `appState.selectedRoom` → content 열 `RoomView`, detail 열 `MemberDetailColumn`(선택된 팀원 타임라인 `TimelineView(sessionId:)`, 없으면 팀원 목록). `RoomView` 가 팀원 타임라인을 열 때 compact 는 push, regular 는 `appState.selectedMemberSessionId` 갱신.

### 6. 테스트 (먼저 쓴다)

- `RoomComposerStateTests`: 캡션 규칙(그룹방·멘션 없음·빈 텍스트·DM·모르는 토큰), 제안 칩 목록, 삽입 결과 — 순수 구조체 `RoomComposerState.make(text:room:members:lead:)` 로 뽑아 테스트.
- `WorkingBubbleTextTests`: "지연이 작업 중…", 여러 명 "지연, 민수가 작업 중…", 대기 중 문구.
- `TeamRoomsViewLogicTests`: 방 행 정렬(`#전체` 먼저, DM 은 팀원 순서), 상태 점 상태 파생(`MemberStatus`).
- `UIHostingController` 렌더 확인: `MessageCard(.agent)` 가 Markdown 을 그리고 `MemberChip` 텍스트를 담는지, `RoomView` 가 스냅샷 fixture 로 4개 항목을 그리는지(버튼은 누르지 못하므로 렌더만).

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
test -f ios/MacAgent/Features/Rooms/RoomView.swift
test -f ios/MacAgent/Features/Rooms/RoomComposer.swift
test -f ios/MacAgent/Features/Teams/TeamRoomsView.swift
test -f ios/MacAgent/Shared/MemberAvatar.swift
! grep -rn "NavigationStack" ios/MacAgent/Features/Rooms/RoomView.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `RoomView` 안에 `NavigationStack` 을 중첩하지 않았는가(IOS.md 9.1)?
   - 시스템 색·SF Symbol 만, 색은 항상 아이콘과 함께(5.4)? 자동 스크롤 규칙이 타임라인과 같은가(5.3)?
   - 상태 변경이 전부 `RoomModel.apply` 를 통하는가? 뷰가 `RoomModel` 의 `private(set)` 을 우회하지 않는가?
   - `xcodegen generate` 를 실행했는가(CRITICAL 8)?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- `RoomView` 안에 `NavigationStack` 을 넣지 마라. 이유: 바깥 스택과 중첩되면 push 가 깨진다(9.1 교훈).
- 정지(stop) 버튼을 컴포저에 두지 마라. 이유: 방에는 여러 팀원이 있으므로 상태 줄의 "중단" 이 팀 전체를 맡는다.
- 작업 요약·승인·변경 카드의 실제 UI 를 만들지 마라(step 6). placeholder 만.
- `Composer.swift` 를 일반화하지 마라. 이유: 세션 컴포저의 running/interrupt 의미가 방과 다르다.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
