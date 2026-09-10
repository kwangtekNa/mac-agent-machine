import SwiftUI

/// 모드 메뉴(ADR-015). `full-auto` 는 confirmationDialog 로 확인한 뒤에만 적용한다.
struct ModeMenu: View {
    static let modes: [SessionMode] = [.ask, .autoEdit, .plan, .fullAuto]

    let mode: SessionMode
    let onSelect: (SessionMode) -> Void
    @State private var confirmsFullAuto = false

    var body: some View {
        Menu {
            ForEach(Self.modes, id: \.self) { candidate in
                Button {
                    if candidate == .fullAuto {
                        confirmsFullAuto = true
                    } else {
                        onSelect(candidate)
                    }
                } label: {
                    Label(candidate.rawValue, systemImage: candidate.symbol)
                }
                .disabled(candidate == mode)
            }
        } label: {
            Image(systemName: mode.symbol)
        }
        .accessibilityLabel("모드: \(mode.rawValue)")
        .confirmationDialog(
            "에이전트가 확인 없이 명령을 실행하고 파일을 수정합니다",
            isPresented: $confirmsFullAuto,
            titleVisibility: .visible
        ) {
            Button("full-auto로 전환", role: .destructive) { onSelect(.fullAuto) }
        }
    }
}

extension SessionMode {
    var symbol: String {
        switch self {
        case .ask: return "questionmark.bubble"
        case .autoEdit: return "pencil.and.outline"
        case .plan: return "list.bullet.clipboard"
        case .fullAuto: return "bolt.fill"
        case .unknown: return "questionmark"
        }
    }
}
