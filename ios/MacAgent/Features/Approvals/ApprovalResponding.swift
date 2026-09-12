import Foundation
import Observation

/// 승인 배너·시트가 기대는 모델 인터페이스. 세션 화면(`TimelineModel`)과 방 화면(`RoomModel`)이 같은 UI 로 승인을 처리한다.
/// 확정은 항상 서버 이벤트(`approval.resolved` / `room.message.updated`)이며 구현체는 pending 을 낙관적으로 바꾸지 않는다.
@MainActor
protocol ApprovalResponding: AnyObject, Observable {
    /// requestedAt 오름차순.
    var pendingApprovals: [Approval] { get }
    var approvalSubmit: ApprovalSubmitState { get }
    func respond(to approval: Approval, optionId: String, inputs: [String: String]?, message: String?) async
    /// 방에서 작성자 표시(예: "🧑‍💻 지연 · 개발자"). 타임라인은 nil.
    func authorLabel(for approval: Approval) -> String?
}

extension ApprovalResponding {
    func authorLabel(for approval: Approval) -> String? { nil }
}

/// 세션 화면. 시그니처가 이미 같으므로 conformance 만 선언한다(작성자 캡션 없음).
extension TimelineModel: ApprovalResponding {}
