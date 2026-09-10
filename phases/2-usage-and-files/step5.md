# Step 5: ios-files-tab-mkdir

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (9.1 세그먼트, 9.2 디렉토리 피커, 5절 디자인·문구)
- `/docs/PROTOCOL.md` (`POST /fs/mkdir`, `/fs/list`)
- `/ios/MacAgent/Features/Timeline/TimelineView.swift` (툴바 폴더 버튼과 `.sheet(isPresented: $showsFiles)`, `openFiles()`), `/ios/MacAgent/App/SplitRootView.swift`, `AppState.swift`(`fileBrowserModel(for:cwd:client:)`)
- `/ios/MacAgent/Features/Files/FileBrowserModel.swift`, `FileBrowserView.swift`
- `/ios/MacAgent/Features/Sessions/NewSessionSheet.swift`, `SessionsStore.swift`
- `/ios/MacAgent/Networking/APIClient.swift` (step 4의 `makeDirectory`)
- `/ios/MacAgent/Features/Timeline/TimelineModel.swift` (`items`에서 `file_change` 경로 집계)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

세션 화면에 "대화 | 파일" 세그먼트를 넣고 파일 브라우저를 인라인으로 보여준다. 새 세션 시트에 홈부터 탐색하는 디렉토리 피커와 "새 폴더"를 붙인다.

### 1. 세그먼트 (`Features/Timeline/`)

- `TimelineView`(compact): 내비게이션 바 아래 `Picker("", selection: $tab)`(`.pickerStyle(.segmented)`, 좌우 여백 16, 상하 8, 배경 `Color(.systemGroupedBackground)`). 라벨 "대화" / "파일" + 변경 수(`changedFileCount > 0`이면 "파일 3").
- `changedFileCount`는 `TimelineModel`의 계산 프로퍼티: `items` 중 `.fileChange` payload의 `files[].path`를 Set으로 모아 개수. `TimelineModel`에 `var changedFilePaths: Set<String>`를 아이템 upsert 시 갱신(매번 전체 순회 금지).
- 파일 탭: `FileBrowserView(model: appState.fileBrowserModel(for:cwd:client:), embedded: true)`를 인라인으로. `embedded`면 자체 `NavigationStack`은 유지하되 닫기 버튼 없음, 시트 detents 없음. 탭 전환 시 상태 유지(모델이 `AppState`에 있으므로 뷰만 바뀜).
- 컴포저와 승인 배너는 두 탭 모두에서 `safeAreaInset(edge: .bottom)`으로 보인다. 파일 탭에서 배너의 버튼도 동작한다.
- 툴바의 폴더 아이콘 버튼과 `showsFiles` 시트를 제거한다(`onToggleFiles`는 iPad 경로에서 계속 쓰이면 유지). iPad(regular)에서는 세그먼트를 숨기고 기존 3열 유지(`SplitRootView`).
- 파일 탭에서 `FileBrowserModel`이 아직 로드 전이면 등장 시 `load(root)`.

### 2. 디렉토리 피커 (`Features/Files/DirectoryPickerView.swift`)

- `FileBrowserModel`에 `mode: .files | .directories` 추가. `.directories`면 `visibleEntries`가 `type == .dir`만 반환하고 파일 탭은 비활성.
- `DirectoryPickerView(client:, initialPath: "~", onPick: (String) -> Void)`: `NavigationStack` + 디렉토리 목록(기존 행 뷰 재사용, 파일은 숨김). 제목 = 현재 폴더 이름, 부제 = 전체 경로. 툴바: 숨김 토글, **새 폴더**(`folder.badge.plus`) → `alert("새 폴더", TextField("이름"))` → 검증(빈 값, `/` 포함, 제어 문자 → 인라인 오류) → `client.makeDirectory(path: current + "/" + name)` → 성공 시 목록 갱신 후 그 폴더로 push. 409 → "이미 있는 이름입니다", 403/400 → 서버 메시지.
- 하단 고정 바(`safeAreaInset`): 현재 경로 monospaced 캡션 + `Button("이 폴더 선택")`(`.borderedProminent`) → `onPick(currentPath)` 후 dismiss.
- 홈 위로는 올라가지 않는다(서버 샌드박스와 동일).

### 3. 새 세션 시트 (`Features/Sessions/NewSessionSheet.swift`)

- "디렉토리" 섹션을 재구성: 현재 선택 경로 표시 행(없으면 "선택 안 됨"), 아래에 세 버튼/행: **프로젝트에서 선택**(기존 Picker를 메뉴로), **찾아보기…**(`DirectoryPickerView` 시트, 시작 경로는 선택된 프로젝트 경로 또는 `~`), **직접 입력**(기존 TextField 토글). 선택 결과는 하나의 `selectedPath: String` 상태로 합쳐진다.
- "세션 시작"은 `selectedPath`가 비어 있으면 비활성. 서버 400/403 메시지는 기존대로.

### 4. 테스트 (`ios/MacAgentTests/Features/`)

- `TimelineModelTests` 확장: `file_change` 아이템 upsert 시 `changedFilePaths` 갱신(중복 경로 1회, 같은 아이템 completed로 교체돼도 중복 없음).
- `FileBrowserModelTests` 확장: `.directories` 모드 필터, 새 폴더 성공 후 push, 409/400 오류 메시지(스텁 클라이언트).
- `DirectoryNameValidationTests`: 빈 값, 슬래시, 제어 문자, 정상.
- `NewSessionSheetLogicTests`(폼 상태 분리): 세 진입점이 같은 `selectedPath`를 갱신, 비어 있으면 제출 불가.

### 5. 수동 확인

개발 서버(`bash scripts/dev-smoke.sh --keep`)에서: 새 세션 → 찾아보기 → `~` 아래 탐색 → 새 폴더 `mam-picker-test` 생성 → 선택 → 세션 시작 → 세그먼트 "파일"에서 그 폴더가 비어 있음 확인 → "hello" 전송 후 Fake의 파일 변경이 있으면 "파일 N" 배지 확인. 스크린샷을 찍어 9.1/9.2 규격과 비교하라. 만든 테스트 폴더는 `~/mam-picker-test`이며 확인 후 `rmdir`로 지운다(비어 있음).

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
grep -q "DirectoryPickerView" ios/MacAgent/Features/Sessions/NewSessionSheet.swift
grep -q "pickerStyle(.segmented)" ios/MacAgent/Features/Timeline/TimelineView.swift
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `docs/IOS.md` 9.1(세그먼트, 인라인, 배지, 컴포저·배너 유지, iPad 예외)과 9.2(피커, 새 폴더, 하단 선택 바)를 그대로 따르는가?
   - 경로 검증은 UI 편의일 뿐이고 최종 판단은 서버 응답을 그대로 보여주는가?
   - 5.5 문구 규칙을 지키는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 파일 삭제·이름 변경·이동 UI를 만들지 마라. 폴더 생성만.
- 피커가 홈 밖으로 나가는 진입점(루트 `/`, 상위 이동)을 만들지 마라.
- 세그먼트를 iPad 3열에 중복 표시하지 마라.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
