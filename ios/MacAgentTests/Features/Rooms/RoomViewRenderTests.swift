import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

/// `UIHostingController` 렌더 확인: `MessageCard(.agent)` 가 Markdown 을 그리고 `MemberChip` 텍스트를 담는지,
/// `RoomScreen` 이 스냅샷 fixture 의 4개 항목을 그리는지(버튼은 누르지 못하므로 렌더만).
@MainActor
final class RoomViewRenderTests: XCTestCase {
    private let baseURL = URL(string: "http://127.0.0.1:7777")!
    private let teamId = "team_01J8ZQ4K5N7P9R3S6T8V0W2XT1"
    private let roomId = "room_01J8ZQ4K5N7P9R3S6T8V0W2XR0"
    private var team: Team!
    private var minsu: TeamMember!
    private var jiyeon: TeamMember!
    private var factory: FakeTransportFactory!

    override func setUp() async throws {
        try await super.setUp()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        minsu = team.members[0]
        jiyeon = team.members[1]
        factory = FakeTransportFactory([])
    }

    override func tearDown() async throws {
        StubURLProtocol.handler = nil
        try await super.tearDown()
    }

    private func roomMessage(_ fixture: String) throws -> RoomMessage {
        let event = try JSONCoding.decoder.decode(RoomEvent.self, from: FixtureLoader.data("room-ws/\(fixture).json"))
        guard case .roomMessage(let e) = event else { throw XCTSkip("room.message 가 아니다") }
        return e.message
    }

    private func height<V: View>(_ view: V, width: CGFloat = 390) -> CGFloat {
        UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 4000)).height
    }

    // MARK: - MessageCard

    func testAgentMessageCardRendersMarkdownAndMemberChip() throws {
        let message = try roomMessage("room.message.agent")
        let card = MessageCard(message: message, role: .agent(member: minsu))

        XCTAssertEqual(
            MessageCard.accessibilityLabel(message: message, role: .agent(member: minsu)),
            "민수(팀장): \(message.text)"
        )
        XCTAssertEqual(
            MessageCard.accessibilityLabel(message: message, role: .agent(member: nil)),
            "팀원: \(message.text)", "팀원을 모르면 일반 이름"
        )
        XCTAssertEqual(MessageCard.chipText(for: .agent(member: jiyeon)), "🧑‍💻 지연 · 개발자 · Codex")

        let base = height(card)
        XCTAssertGreaterThan(base, 60, "칩 행 + 본문")

        var long = message
        long.text = "# 제목\n\n- 항목 하나\n- 항목 둘\n- 항목 셋\n\n```swift\nlet x = 1\nlet y = 2\n```\n\n마지막 문단."
        let tall = height(MessageCard(message: long, role: .agent(member: minsu)))
        XCTAssertGreaterThan(tall, base + 80, "Markdown 블록(제목·목록·코드)이 실제로 그려진다")
    }

    func testUserMessageCardRenders() throws {
        let message = try roomMessage("room.message.user")
        XCTAssertEqual(MessageCard.accessibilityLabel(message: message, role: .user), "나: \(message.text)")
        XCTAssertGreaterThan(height(MessageCard(message: message, role: .user)), 30)
    }

    // MARK: - RoomScreen

    func testRoomScreenRendersSnapshotEntries() async throws {
        let teamPath = "/api/v1/teams/\(teamId)"
        let roomPath = "/api/v1/teams/\(teamId)/rooms/\(roomId)"
        StubURLProtocol.handler = { request in
            let path = request.url?.path() ?? ""
            let body: Data
            switch path {
            case teamPath: body = try FixtureLoader.data("rest/team-detail.json")
            case roomPath: body = try FixtureLoader.data("rest/room.json")
            default: throw URLError(.unsupportedURL)
            }
            return StubURLProtocol.response(request, status: 200, body: body)
        }
        let client = APIClient(baseURL: baseURL, session: StubURLProtocol.makeSession())
        let factory = self.factory!
        let model = RoomModel(
            teamId: teamId, roomId: roomId, client: client,
            socketFactory: { teamId, roomId, since in
                RoomSocket(baseURL: client.baseURL, teamId: teamId, roomId: roomId, since: since, transportFactory: { factory.make() })
            }
        )
        let snapshot = try JSONCoding.decoder.decode(RoomEvent.self, from: FixtureLoader.data("room-ws/room.snapshot.json"))
        model.apply(snapshot)
        XCTAssertEqual(model.entries.count, 4)

        // 항목마다 그려지고, 4개를 한 목록에 그린 높이는 각각의 합에 가깝다.
        let members = team.members
        let each = model.entries.map { height(RoomEntryRow(entry: $0, members: members, onReply: { _ in })) }
        for (entry, h) in zip(model.entries, each) {
            XCTAssertGreaterThan(h, 14, "\(entry.id) 가 그려진다")
        }
        let list = VStack(spacing: 12) {
            ForEach(model.entries) { RoomEntryRow(entry: $0, members: members, onReply: { _ in }) }
        }
        XCTAssertGreaterThanOrEqual(height(list), each.reduce(0, +) * 0.9)

        // 화면 전체(툴바·배너·컴포저 포함)가 창 안에서 그려진다.
        let appState = AppState()
        let screen = RoomScreen(model: model)
            .environment(appState)
            .environment(SessionsStore(client: client))
            .environment(TeamsStore(client: client))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIHostingController(rootView: screen)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            model.stop()
        }
        controller.view.layoutIfNeeded()
        for _ in 0..<5 {
            try await Task.sleep(for: .milliseconds(30))
            controller.view.layoutIfNeeded()
        }
        XCTAssertGreaterThan(controller.view.bounds.height, 0)
        XCTAssertEqual(model.entries.count, 7, "start() 의 REST 재조회(rest/room.json 7건)가 id 로 합쳐진다")
        XCTAssertEqual(model.pendingApprovals.count, 1, "배너에 그릴 대기 승인")
        XCTAssertEqual(model.workingMembers.map(\.name), ["지연"], "말풍선에 그릴 작업 중 팀원")
    }
}
