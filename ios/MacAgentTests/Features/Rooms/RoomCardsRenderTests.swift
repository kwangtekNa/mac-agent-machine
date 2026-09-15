import SwiftUI
import UIKit
import XCTest
@testable import MacAgent

/// `UIHostingController` 렌더 확인(버튼은 누르지 못하므로 렌더만): 카드가 실제로 그려지고, 상태에 따라 행이 늘고 준다.
/// 그려지는 문구는 같은 순수 상태(`ChangesCardState`·`WorkSummaryLabel`·`RoomApprovalCardState`)에서 온다.
@MainActor
final class RoomCardsRenderTests: XCTestCase {
    private var team: Team!
    private var jiyeon: TeamMember!

    override func setUp() async throws {
        try await super.setUp()
        team = try JSONCoding.decoder.decode(Team.self, from: FixtureLoader.data("rest/team.json"))
        jiyeon = team.members[1]
    }

    private func message(_ fixture: String) throws -> RoomMessage {
        let event = try JSONCoding.decoder.decode(RoomEvent.self, from: FixtureLoader.data("room-ws/\(fixture).json"))
        switch event {
        case .roomMessage(let e): return e.message
        case .roomMessageUpdated(let e): return e.message
        default: throw XCTSkip("메시지 이벤트가 아니다")
        }
    }

    private func height<V: View>(_ view: V, width: CGFloat = 390) -> CGFloat {
        UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 4000)).height
    }

    /// 카드를 제 크기로 창에 붙여 그린다. 배경색을 실제 픽셀로 읽기 위해 라이트 모드로 고정한다.
    private func renderCard<V: View>(_ view: V, width: CGFloat = 390) -> (image: UIImage, size: CGSize) {
        let controller = UIHostingController(rootView: view)
        let size = CGSize(width: width, height: controller.sizeThatFits(in: CGSize(width: width, height: 4000)).height)
        let window = UIWindow(frame: CGRect(origin: .zero, size: size))
        window.overrideUserInterfaceStyle = .light
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.view.frame = CGRect(origin: .zero, size: size)
        controller.view.layoutIfNeeded()
        defer { window.isHidden = true }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { ctx in
            window.layer.render(in: ctx.cgContext)
        }
        return (image, size)
    }

    /// 그려진 이미지의 한 점 색(0~1). 노란 배경은 파랑 채널만 크게 내려간다.
    private func color(_ image: UIImage, at point: CGPoint) throws -> (r: CGFloat, g: CGFloat, b: CGFloat) {
        let cg = try XCTUnwrap(image.cgImage)
        let scale = image.scale
        let rect = CGRect(x: (point.x * scale).rounded(.down), y: (point.y * scale).rounded(.down), width: 1, height: 1)
        let pixelImage = try XCTUnwrap(cg.cropping(to: rect))
        var pixel: [UInt8] = [0, 0, 0, 0]
        let context = try XCTUnwrap(
            pixel.withUnsafeMutableBytes { bytes in
                CGContext(
                    data: bytes.baseAddress,
                    width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
                )
            }
        )
        context.draw(pixelImage, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return (CGFloat(pixel[0]) / 255, CGFloat(pixel[1]) / 255, CGFloat(pixel[2]) / 255)
    }


    func testChangesReadyCardRendersMergeButtonAndFiles() throws {
        let changes = try message("room.message.changes")
        let ready = ChangesReadyCard(message: changes, member: jiyeon, submit: .idle, onMerge: {}, onDismiss: {})
        XCTAssertEqual(ChangesCardState.make(message: changes, member: jiyeon, submit: .idle).action, .merge(label: "main에 병합"))
        let readyHeight = height(ready)
        XCTAssertGreaterThan(readyHeight, 120, "제목 + 칩 + 브랜치 + 파일 2행 + 버튼 행")

        var merged = changes
        merged.changes?.status = .merged
        XCTAssertEqual(ChangesCardState.make(message: merged, member: jiyeon, submit: .idle).statusLine, "병합됨 · a1b2c3d")
        let mergedHeight = height(ChangesReadyCard(message: merged, member: jiyeon, submit: .idle, onMerge: {}, onDismiss: {}))
        XCTAssertGreaterThan(mergedHeight, 100, "상태 줄이 그려진다")
        XCTAssertLessThan(mergedHeight, readyHeight, "버튼 행이 사라진다")

        var conflict = changes
        conflict.changes?.status = .conflict
        conflict.changes?.conflictFiles = ["src/login.ts", "src/login.test.ts"]
        let conflictHeight = height(ChangesReadyCard(message: conflict, member: jiyeon, submit: .idle, onMerge: {}, onDismiss: {}))
        XCTAssertGreaterThan(conflictHeight, readyHeight, "충돌 파일 2행 + 캡션이 늘어난다")
    }

    func testWorkSummaryCardRendersOneLine() throws {
        let agent = try message("room.message.agent")
        let work = try XCTUnwrap(agent.work)
        XCTAssertEqual(WorkSummaryLabel.line(work), "도구 2회 · 파일 변경 없음 · 8초 · $0.04 추정")
        let h = height(WorkSummaryCard(messageId: agent.id, member: team.members[0], work: work, onOpen: { _ in }))
        XCTAssertGreaterThan(h, 20)
        XCTAssertLessThan(h, 80, "접힌 한 줄")
    }

    func testRoomApprovalCardRendersChipAndResolution() throws {
        let pending = try message("room.message.approval")
        let pendingHeight = height(RoomApprovalCard(message: pending, member: jiyeon, onShowDetail: {}))
        XCTAssertGreaterThan(pendingHeight, 90, "제목 + 칩 + prompt + 자세히 보기")

        let resolved = try message("room.message.updated")
        XCTAssertEqual(RoomApprovalCardState.make(message: resolved, member: jiyeon).resolutionLine?.hasPrefix("항상 허용됨 · "), true)
        let resolvedHeight = height(RoomApprovalCard(message: resolved, member: jiyeon, onShowDetail: {}))
        XCTAssertGreaterThan(resolvedHeight, 60)
        XCTAssertLessThan(resolvedHeight, pendingHeight, "해결되면 한 줄 요약만 남는다")
    }

    /// 서버가 정리한 유령 승인(ADR-019)은 "시스템이 취소함" 으로 그려지고 노란 대기 배경이 아니다.
    /// SwiftUI 는 하위 `UIView` 를 만들지 않아 문구를 계층에서 읽을 수 없으므로, 그려진 픽셀(배경색)과
    /// 같은 카드를 사람이 중단한 경우와의 이미지 차이로 본다. 문구 자체는 같은 순수 규칙이 만든다.
    func testSystemResolvedApprovalCardShowsSystemLabelWithoutPendingBackground() throws {
        var cleaned = try message("room.message.updated")
        let at = Date(timeIntervalSince1970: 1_757_000_000)
        cleaned.approval?.resolution = ApprovalResolution(optionId: "abort", by: .system, at: at)
        XCTAssertEqual(
            RoomApprovalCardState.make(message: cleaned, member: jiyeon).resolutionLine,
            "시스템이 취소함 · \(Formatters.clock(at))"
        )

        // 배경: 대기 중은 노란 배경(파랑 채널만 내려간다), 해결된 카드는 회색조 카드 배경이다.
        let pending = try message("room.message.approval")
        let pendingRender = renderCard(RoomApprovalCard(message: pending, member: jiyeon, onShowDetail: {}))
        let pendingColor = try color(pendingRender.image, at: CGPoint(x: pendingRender.size.width - 4, y: pendingRender.size.height / 2))
        XCTAssertGreaterThan(pendingColor.r - pendingColor.b, 0.1, "대기 중은 노란 배경이다")

        let cleanedRender = renderCard(RoomApprovalCard(message: cleaned, member: jiyeon, onShowDetail: {}))
        let cleanedColor = try color(cleanedRender.image, at: CGPoint(x: cleanedRender.size.width - 4, y: cleanedRender.size.height / 2))
        XCTAssertLessThan(abs(cleanedColor.r - cleanedColor.b), 0.05, "해결된 카드는 회색조 배경이다")
        XCTAssertLessThan(cleanedRender.size.height, pendingRender.size.height, "해결되면 한 줄 요약만 남는다")

        // 같은 카드를 사람이 중단한 경우와 다른 픽셀을 그린다(본문이 `by` 를 본다는 뜻).
        var aborted = cleaned
        aborted.approval?.resolution = ApprovalResolution(optionId: "abort", by: .client, at: at)
        let abortedRender = renderCard(RoomApprovalCard(message: aborted, member: jiyeon, onShowDetail: {}))
        XCTAssertEqual(abortedRender.size, cleanedRender.size, "둘 다 한 줄짜리 해결 카드")
        XCTAssertNotEqual(
            cleanedRender.image.pngData(), abortedRender.image.pngData(),
            "'시스템이 취소함' 과 '중단됨' 이 같게 그려지면 안 된다"
        )
    }

    func testSideRoomCardRendersTitleAndConclusion() async throws {
        let opened = try message("room.message.side-opened")
        let state = try XCTUnwrap(SideRoomCardState.make(message: opened, members: team.members))
        XCTAssertEqual(state.title, "민수 ↔ 지연 곁방을 열었습니다")

        // 실제 창에 붙여 레이아웃이 도는지 본다(다른 카드 렌더 테스트와 같은 방식).
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIHostingController(rootView: SideRoomCard(state: state, onOpen: { _ in }))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        controller.view.layoutIfNeeded()
        for _ in 0..<3 {
            try await Task.sleep(for: .milliseconds(20))
            controller.view.layoutIfNeeded()
        }
        XCTAssertGreaterThan(controller.view.bounds.height, 0)

        let openedHeight = height(SideRoomCard(state: state, onOpen: { _ in }))
        XCTAssertGreaterThan(openedHeight, 40, "제목 줄 + 아바타 줄")
        XCTAssertLessThan(openedHeight, 120, "펼친 본문이 아니라 두 줄짜리 카드")

        let closed = try XCTUnwrap(SideRoomCardState.make(message: try message("room.message.side-closed"), members: team.members))
        XCTAssertEqual(closed.detail, "린트 오류 3건을 고쳤습니다")
        XCTAssertGreaterThan(
            height(SideRoomCard(state: closed, onOpen: { _ in })), openedHeight,
            "결론 한 줄이 붙으면 카드가 커진다"
        )

        // 제목이 길어져 두 줄이 되지는 않는다(IOS.md 5.1 카드 제목은 한 줄).
        let long = SideRoomCardState(
            title: String(repeating: "아주 긴 제목 ", count: 20), detail: nil, isClosed: false,
            roomId: state.roomId, participants: state.participants, createdAt: state.createdAt
        )
        XCTAssertEqual(height(SideRoomCard(state: long, onOpen: { _ in })), openedHeight, accuracy: 1)
    }

    func testRoomEntryRowDrawsSideRoomCard() throws {
        let opened = try message("room.message.side-opened")
        let entry = RoomEntry.make(opened)
        let rowHeight = height(RoomEntryRow(entry: entry, members: team.members, onReply: { _ in }))
        let plain = height(RoomEntryRow(entry: .system(opened), members: team.members, onReply: { _ in }))
        XCTAssertGreaterThan(rowHeight, plain, "연결 카드는 한 줄짜리 시스템 행보다 크다")
        XCTAssertEqual(ItemStyle.roomStyle(for: entry).symbol, "bubble.left.and.bubble.right")
        XCTAssertEqual(ItemStyle.roomStyle(for: entry).tint, .secondary)
    }

    func testRoomEntryRowUsesCardsAndWorkSummary() throws {
        let members = team.members
        let agent = try message("room.message.agent")
        let rowHeight = height(RoomEntryRow(entry: .message(agent), members: members, onReply: { _ in }))
        let cardHeight = height(MessageCard(message: agent, role: .agent(member: members[0])))
        XCTAssertGreaterThan(rowHeight, cardHeight + 30, "work 가 있으면 아래에 작업 요약이 붙는다")

        var plain = agent
        plain.work = nil
        XCTAssertEqual(height(RoomEntryRow(entry: .message(plain), members: members, onReply: { _ in })), cardHeight, accuracy: 1)

        let changes = try message("room.message.changes")
        XCTAssertGreaterThan(height(RoomEntryRow(entry: .changes(changes), members: members, onReply: { _ in })), 120)
        let approval = try message("room.message.approval")
        XCTAssertGreaterThan(height(RoomEntryRow(entry: .approval(approval), members: members, onReply: { _ in })), 90)
    }
}
