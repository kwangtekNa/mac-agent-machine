import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

/// `MemberControlSheet` 가 `UIHostingController` 에서 "권한"·"모델" 섹션과 팀원 칩을 그리는지(버튼은 누르지 못하므로 렌더만).
@MainActor
final class MemberControlSheetRenderTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!

    override func tearDown() async throws {
        StubURLProtocol.handler = nil
        try await super.tearDown()
    }

    /// SwiftUI `Form` 은 `UICollectionView` 로 그려진다. 섹션 수로 헤더·권한·모델·사고 수준·브랜치·동작 섹션이 만들어졌는지 본다.
    private static func collectionViews(in root: UIView) -> [UICollectionView] {
        var found: [UICollectionView] = []
        func visit(_ view: UIView) {
            if let collection = view as? UICollectionView { found.append(collection) }
            for subview in view.subviews { visit(subview) }
        }
        visit(root)
        return found
    }

    func testSheetRendersSectionsChipAndBranch() async throws {
        let team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        let minsu = team.members[0]
        StubURLProtocol.handler = { request in
            guard request.url?.path() == "/api/v1/models" else { throw URLError(.unsupportedURL) }
            return StubURLProtocol.response(request, status: 200, body: try FixtureLoader.data("rest/models-claude.json"))
        }
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        let teamsStore = TeamsStore(client: client)
        let sheet = MemberControlSheet(teamId: team.id, member: minsu, state: .running)
            .environment(teamsStore)

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIHostingController(rootView: sheet)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        controller.view.layoutIfNeeded()
        for _ in 0..<6 {
            try await Task.sleep(for: .milliseconds(30))
            controller.view.layoutIfNeeded()
        }
        XCTAssertGreaterThan(controller.view.bounds.height, 0)
        XCTAssertEqual(teamsStore.modelsByAgent[.claude]?.count, 3, "열 때 GET /models?agent=claude 를 읽는다")

        // 헤더 · 권한 · 모델 · 사고 수준(claude-opus-5 는 efforts 있음) · 브랜치 · 동작 = 6 섹션.
        let form = try XCTUnwrap(Self.collectionViews(in: controller.view).max { $0.numberOfSections < $1.numberOfSections })
        XCTAssertEqual(form.numberOfSections, 6, "권한·모델·사고 수준·브랜치 섹션이 그려진다")
        XCTAssertEqual(MemberControlSheet.modeSectionTitle, "권한")
        XCTAssertEqual(MemberControlSheet.modelSectionTitle, "모델")
        XCTAssertEqual(MemberControlSheet.branchSectionTitle, "브랜치")
        XCTAssertEqual(MemberChip.text(for: minsu), "\(minsu.emoji) 민수 · 팀장 · Claude", "헤더 칩 문구")
        XCTAssertEqual(minsu.branch, "mam/backend/minsu", "브랜치 행(읽기 전용)")
    }
}
