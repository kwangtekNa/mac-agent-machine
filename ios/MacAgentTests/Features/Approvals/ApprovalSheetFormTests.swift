import Foundation
import XCTest
@testable import MacAgent

/// 승인 시트의 입력 폼 검증 로직(`ApprovalFormState`).
@MainActor
final class ApprovalSheetFormTests: XCTestCase {
    private func approval(_ fixture: String) throws -> Approval {
        let event = try JSONCoding.decoder.decode(ServerEvent.self, from: FixtureLoader.data("ws/approval.requested.\(fixture).json"))
        guard case .approvalRequested(let e) = event else { throw XCTSkip("approval.requested fixture 가 아니다") }
        return e.approval
    }

    func testChoiceDefaultsToFirstChoiceAndTextStartsEmpty() throws {
        let form = ApprovalFormState(approval: try approval("user_input"))
        XCTAssertEqual(form.inputs["strategy"], "merge")
        XCTAssertEqual(form.inputs["branch"], "")
        XCTAssertEqual(form.inputs["token"], "")
    }

    func testCannotSubmitWhileRequiredInputsAreEmpty() throws {
        let approval = try approval("user_input")
        var form = ApprovalFormState(approval: approval)
        XCTAssertFalse(form.canSubmit(approval))

        form.inputs["branch"] = "feature/login"
        XCTAssertFalse(form.canSubmit(approval), "secret 도 필수")

        form.inputs["token"] = "   "
        XCTAssertFalse(form.canSubmit(approval), "공백만 있으면 비어 있는 것")

        form.inputs["token"] = "tok_123"
        XCTAssertTrue(form.canSubmit(approval))
        XCTAssertEqual(form.payloadInputs(approval), ["branch": "feature/login", "token": "tok_123", "strategy": "merge"])
    }

    func testNoInputFieldsAlwaysSubmittableWithNilInputs() throws {
        let approval = try approval("command")
        let form = ApprovalFormState(approval: approval)
        XCTAssertTrue(form.canSubmit(approval))
        XCTAssertNil(form.payloadInputs(approval))
    }

    func testDenyLikeOptionsAndReasonMessage() {
        XCTAssertTrue(ApprovalFormState.isDenyLike("deny"))
        XCTAssertTrue(ApprovalFormState.isDenyLike("abort"))
        XCTAssertFalse(ApprovalFormState.isDenyLike("allow"))
        XCTAssertFalse(ApprovalFormState.isDenyLike("cancel"))

        var form = ApprovalFormState(approval: Approval(
            approvalId: "apr_x", itemId: "itm_x", kind: .command, title: "t", prompt: "p", detail: nil, diff: nil,
            options: [], inputFields: [], requestedAt: .now
        ))
        XCTAssertNil(form.reasonMessage, "빈 사유는 보내지 않는다")
        form.denyReason = "  CI에서 돌립니다  "
        XCTAssertEqual(form.reasonMessage, "CI에서 돌립니다")
    }
}
