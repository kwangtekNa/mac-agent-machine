import SwiftUI

/// 하단 입력: 1~6줄 TextField, `running` 이면 중단(빨강), 아니면 보내기. 소켓이 열려 있지 않으면 비활성.
struct Composer: View {
    let model: TimelineModel
    /// 값이 바뀌면 필드에 포커스한다(ErrorCard "다시 시도").
    var focusRequest: Int
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let error = model.transientError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityLabel("오류: \(error)")
            }
            if case .reconnecting = model.socketState {
                Text("다시 연결 중…").font(.caption).foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("메시지", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                if model.status == .running {
                    Button {
                        Task { await model.interrupt() }
                    } label: {
                        Image(systemName: "stop.circle.fill").font(.title)
                    }
                    .tint(.red)
                    .accessibilityLabel("중단")
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill").font(.title)
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
                    .accessibilityLabel("보내기")
                }
            }
            .disabled(model.socketState != .open)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .onChange(of: focusRequest) { _, _ in focused = true }
    }

    private func send() {
        let outgoing = text
        text = ""
        Task { await model.send(text: outgoing) }
    }
}
