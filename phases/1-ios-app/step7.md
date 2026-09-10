# Step 7: file-browser-ui

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md`
- `/docs/IOS.md` (4절의 파일 시트, 5절 디자인, 7절 파일 뷰어 엣지)
- `/docs/PROTOCOL.md` (1절 `/fs/list`, `/fs/read`, `/git/status`, `/git/diff`)
- `/packages/server/src/fs/language.ts` (서버가 주는 `language` 식별자 목록. Highlightr 이름으로 매핑한다)
- `/packages/server/src/fs/read.ts` (1 MiB 절단, 이미지 base64, 415 규칙)
- `/ios/MacAgent/Networking/APIClient.swift` (step 2), `/ios/MacAgent/Shared/DiffTextView.swift` (step 5), `/ios/MacAgent/Features/Timeline/TimelineView.swift` (툴바 "파일" 자리표시자)

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

세션의 작업 디렉토리를 탐색하고 파일을 보는 화면을 만든다. 읽기 전용이다. 타임라인 툴바 "파일" 버튼이 이 화면을 시트로 연다(iPad 열 배치는 step 8).

### 1. `ios/MacAgent/Features/Files/FileBrowserModel.swift`

```swift
@MainActor @Observable final class FileBrowserModel {
  struct Directory: Identifiable, Hashable { let path: String; var listing: FsListResponse?; var error: String? }
  let rootPath: String                      // 세션 cwd
  private(set) var stack: [Directory]       // NavigationStack path
  var showHidden: Bool                      // 기본 false, UserDefaults 기억
  init(client: APIClient, rootPath: String)
  func load(_ path: String) async           // 캐시 + refresh
  func push(_ path: String) / func pop()
  func visibleEntries(of dir: Directory) -> [FsEntry]   // showHidden 필터, 서버 정렬 유지
}
enum GitBadge { static func style(_ code: GitStatusCode?) -> (text: String, color: Color)? }  // M 주황, A 초록, D 빨강, R 청록, ? 회색, ! secondary, nil → nil
```

### 2. `FileBrowserView.swift`

- 시트 안 `NavigationStack(path: $model.stack)`. 루트 제목은 cwd 마지막 컴포넌트, 부제(툴바 하단 캡션)에 전체 경로 monospaced. 상위로 가기는 표준 뒤로 가기.
- 행: 아이콘(`dir` `folder.fill .blue`, `file` 확장자별: 코드 `doc.text`, 이미지 `photo`, 마크다운 `doc.richtext`, 그 외 `doc`; `symlink` `link`; `other` `questionmark.folder`), 이름(숨김이면 `.secondary`), 오른쪽 크기(`ByteCountFormatter`, 파일만) + git 배지 캡슐(한 글자). 디렉토리는 chevron.
- 툴바: 숨김 파일 토글(`eye`/`eye.slash`), 새로고침. `refreshable`.
- 빈 폴더: "비어 있는 폴더". 오류: 메시지 + "다시 시도". 403/404는 IOS.md 7절 문구.
- 파일 탭 → `FileViewerView(path:)`.

### 3. `FileViewerView.swift` + `HighlightedCodeView.swift`

- 로드: `readFile(path:)`. 상단에 `truncated`면 "앞 1 MiB만 표시합니다" 배너. 415 → `ContentUnavailableView("미리 볼 수 없는 파일 형식", systemImage: "doc.questionmark")`.
- 텍스트: `HighlightedCodeView`(`UIViewRepresentable`로 `UITextView` 비편집·선택 가능). `Highlightr()`로 `NSAttributedString`을 만든다. 테마는 라이트 `"xcode"`, 다크 `"atom-one-dark"`(`colorScheme` 변화 시 재적용). 폰트는 `UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize * 0.85, weight: .regular)`, Dynamic Type 변경 시 갱신. 하이라이트는 `size <= 200 KiB`일 때만, 그 이상은 plain monospaced(성능). 하이라이트 작업은 `Task.detached`에서 하고 결과만 메인에 적용.
- `Shared/HighlightrLanguage.swift`: 서버 `language` → Highlightr 이름. `typescript`, `javascript`, `swift`, `python`, `ruby`, `go`, `rust`, `java`, `kotlin`, `c`, `cpp`, `objective-c`→`objectivec`, `shell`→`bash`, `json`, `yaml`, `toml`→`ini`, `markdown`, `html`→`xml`, `css`, `scss`, `sql`, `xml`, `dockerfile`, `makefile`, `plaintext`→nil(하이라이트 안 함). 모르는 값 → nil.
- 툴바: 줄바꿈 토글(기본 끔 = 가로 스크롤), 공유(`ShareLink`로 텍스트), 리포 안이고 gitStatus가 `M`/`A`/`D`이면 "변경 보기" → `DiffSheet`(`gitDiff(cwd: rootPath, path:)` → `DiffTextView`).
- 이미지(`encoding == base64`): `Image(uiImage:)`를 `ScrollView`에 넣고 핀치 줌(`MagnifyGesture`). 실패 시 "이미지를 열 수 없습니다".
- 제목은 파일 이름, 부제에 `language`와 크기.

### 4. 타임라인 연결

`TimelineView` 툴바 "파일" 버튼을 활성화해 `FileBrowserView(model: FileBrowserModel(client:, rootPath: session.cwd))` 시트(`presentationDetents([.large])`)를 연다. 시트를 닫아도 모델은 타임라인 화면이 살아 있는 동안 유지(다시 열면 같은 위치).

### 5. 테스트 (`ios/MacAgentTests/Features/Files/`)

- `FileBrowserModelTests.swift`: fixture `rest/fs-list.json`으로 로드, 숨김 필터, push/pop, 403 오류 문구, 캐시 후 refresh.
- `GitBadgeTests.swift`, `HighlightrLanguageTests.swift`(전 매핑 + 미지 값 nil), `FileIconTests.swift`(확장자 → 심볼).
- `FileViewerLogicTests.swift`: 하이라이트 크기 게이트, base64 → `UIImage` 디코드(fixture `rest/fs-read-image.json`), truncated 배너 조건.

### 6. 수동 확인

개발 서버에서 세션의 파일 시트를 열어 `~/work`(없으면 홈 아래 아무 프로젝트) 탐색, `.ts`·`.md`·`.json` 파일 하이라이트, 라이트/다크 전환, 이미지 파일, 큰 파일(>200 KiB) plain 표시, git 변경 파일의 "변경 보기"를 확인하고 스크린샷을 찍어 보라.

## Acceptance Criteria

```bash
cd ios && xcodegen generate --quiet && xcodebuild -scheme MacAgent -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -quiet test && cd ..
bash scripts/test.sh
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 모든 경로 요청이 서버 API를 거치고 앱이 경로를 조작·검증하려 들지 않는가(샌드박스는 서버 책임)?
   - Highlightr 외 하이라이트 구현이 없고, 200 KiB 게이트와 백그라운드 하이라이트를 지키는가?
   - `docs/IOS.md` 5절(시스템 색, 아이콘 + 색 동시 사용)을 따르는가?
3. 최종 결과를 구조화 출력으로 보고한다 (executor가 --json-schema로 강제한다):
   - AC 통과 → `status: "completed"` + `summary`(산출물 한 줄 요약)
   - 수정 3회 시도 후에도 실패 → `status: "error"` + `error_message`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `status: "blocked"` + `blocked_reason` 후 즉시 중단
   - 사용자만 답할 수 있는 모호함·설계 분기 → `status: "needs_input"` + `questions`

## 금지사항

- 파일 편집·저장·삭제·업로드 UI를 만들지 마라. 이유: v1은 읽기 전용(PRD 6절, IOS.md 9절). 서버에도 API가 없다.
- 세션 cwd 밖(홈 전체) 탐색 진입점을 만들지 마라. 루트는 세션 cwd다. 상위 디렉토리로의 이동은 제공하지 않는다.
- 파일 내용을 앱 저장소나 UserDefaults에 캐시하지 마라. 메모리 캐시만.
- 기존 테스트를 깨뜨리지 마라
- git commit/push를 직접 실행하지 마라 (커밋은 executor가 수행한다)
- phases/ 아래 파일을 수정하지 마라
