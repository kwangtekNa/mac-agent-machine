import XCTest
@testable import MacAgent

/// 새 세션 시트의 디렉토리 선택 상태(`NewSessionFormState`). 세 진입점(프로젝트 · 찾아보기 · 직접 입력)이 같은 `selectedPath` 를 갱신한다.
final class NewSessionSheetLogicTests: XCTestCase {
    private let projects = [
        Project(path: "/Users/alice/work/app", name: "app", isGitRepo: true, lastSessionAt: nil, sessionCount: 1),
        Project(path: "/Users/alice/work/lib", name: "lib", isGitRepo: false, lastSessionAt: nil, sessionCount: 0),
    ]

    func testInitialStateUsesProjectThenCustomThenEmpty() {
        let fromProject = NewSessionFormState.initial(initialCwd: "/Users/alice/work/lib", projects: projects)
        XCTAssertEqual(fromProject.selectedPath, "/Users/alice/work/lib")
        XCTAssertFalse(fromProject.showsCustomInput)

        let fromCustom = NewSessionFormState.initial(initialCwd: "~/other", projects: projects)
        XCTAssertEqual(fromCustom.selectedPath, "~/other")
        XCTAssertTrue(fromCustom.showsCustomInput, "프로젝트 목록에 없는 cwd 는 직접 입력으로 보인다")
        XCTAssertEqual(fromCustom.customPath, "~/other")

        let firstProject = NewSessionFormState.initial(initialCwd: nil, projects: projects)
        XCTAssertEqual(firstProject.selectedPath, "/Users/alice/work/app")
        XCTAssertFalse(firstProject.showsCustomInput)

        let empty = NewSessionFormState.initial(initialCwd: nil, projects: [])
        XCTAssertEqual(empty.selectedPath, "")
        XCTAssertTrue(empty.showsCustomInput, "프로젝트가 없으면 바로 입력할 수 있게 연다")
    }

    func testThreeEntryPointsUpdateTheSameSelectedPath() {
        var form = NewSessionFormState()
        form.chooseProject("/Users/alice/work/app")
        XCTAssertEqual(form.selectedPath, "/Users/alice/work/app")
        XCTAssertEqual(form.selectedProjectPath(in: projects), "/Users/alice/work/app")

        form.pick("/Users/alice/work/new-app")
        XCTAssertEqual(form.selectedPath, "/Users/alice/work/new-app")
        XCTAssertNil(form.selectedProjectPath(in: projects), "프로젝트 목록에 없는 경로면 메뉴 선택은 비어 있다")

        form.toggleCustomInput()
        XCTAssertTrue(form.showsCustomInput)
        XCTAssertEqual(form.customPath, "/Users/alice/work/new-app", "직접 입력은 현재 선택 경로에서 시작한다")
        form.setCustomPath("  ~/vibe/x  ")
        XCTAssertEqual(form.selectedPath, "~/vibe/x", "공백은 다듬는다")
        XCTAssertEqual(form.customPath, "  ~/vibe/x  ", "입력 중인 원문은 그대로 둔다")

        form.chooseProject("/Users/alice/work/lib")
        XCTAssertEqual(form.selectedPath, "/Users/alice/work/lib")
        XCTAssertFalse(form.showsCustomInput, "프로젝트를 고르면 직접 입력은 닫힌다")
        form.toggleCustomInput()
        XCTAssertEqual(form.customPath, "/Users/alice/work/lib")
        form.toggleCustomInput()
        XCTAssertFalse(form.showsCustomInput)
        XCTAssertEqual(form.selectedPath, "/Users/alice/work/lib", "닫아도 선택은 남는다")
    }

    func testCannotSubmitWithoutPath() {
        var form = NewSessionFormState()
        XCTAssertFalse(form.canSubmit(agentAvailable: true, isSubmitting: false))
        form.toggleCustomInput()
        form.setCustomPath("   ")
        XCTAssertFalse(form.canSubmit(agentAvailable: true, isSubmitting: false), "공백만 있으면 비어 있는 것")
        form.pick("/Users/alice/work/app")
        XCTAssertTrue(form.canSubmit(agentAvailable: true, isSubmitting: false))
        XCTAssertFalse(form.canSubmit(agentAvailable: false, isSubmitting: false))
        XCTAssertFalse(form.canSubmit(agentAvailable: true, isSubmitting: true))
    }

    func testBrowseStartPathIsSelectedProjectOrHome() {
        var form = NewSessionFormState()
        XCTAssertEqual(form.browseStartPath(in: projects), "~")
        form.chooseProject("/Users/alice/work/app")
        XCTAssertEqual(form.browseStartPath(in: projects), "/Users/alice/work/app")
        form.setCustomPath("~/somewhere")
        XCTAssertEqual(form.browseStartPath(in: projects), "~", "프로젝트가 아닌 경로면 홈에서 시작")
    }
}
