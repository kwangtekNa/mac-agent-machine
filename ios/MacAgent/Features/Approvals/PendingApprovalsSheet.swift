import SwiftUI

/// 대기 중 승인 목록(오래된 순). 행 탭 → 상세 폼. 실수 방지를 위해 행에 빠른 허용/거절 버튼은 두지 않는다.
struct PendingApprovalsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let model: any ApprovalResponding

    private var pending: [Approval] {
        model.pendingApprovals.sorted { $0.requestedAt < $1.requestedAt }
    }

    var body: some View {
        NavigationStack {
            List(pending) { approval in
                NavigationLink(value: approval.approvalId) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: approval.kind.symbol)
                            .foregroundStyle(.yellow)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(approval.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text(approval.prompt).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Text(Formatters.relativeTime(approval.requestedAt))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .overlay {
                if pending.isEmpty {
                    ContentUnavailableView("대기 중인 승인이 없습니다", systemImage: "hand.raised")
                }
            }
            .navigationTitle("승인 대기 \(pending.count)건")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { approvalId in
                ApprovalDetailForm(model: model, approvalId: approvalId)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { dismiss() }
                }
            }
        }
    }
}
