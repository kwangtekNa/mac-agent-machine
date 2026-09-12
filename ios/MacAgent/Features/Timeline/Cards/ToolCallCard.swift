import SwiftUI

/// 도구 호출: 도구별 아이콘·색, 제목 monospaced 한 줄, exit 코드 캡슐, 출력(접힘)·입력 JSON 토글.
struct ToolCallCard: View {
    let item: TimelineItem
    let payload: ToolCallPayload
    @State private var showsOutput = false
    @State private var showsInput = false
    /// 출력·입력 상자 더블 탭 → 전체 화면 뷰어(`TextContentViewer`). 한 뷰에 fullScreenCover 는 하나만 둔다.
    @State private var fullScreen: FullScreen?

    private enum FullScreen: String, Identifiable {
        case output, input
        var id: String { rawValue }
    }

    var body: some View {
        ItemCard(item: item, style: ItemStyle.style(for: item), title: payload.title, titleMonospaced: true, badge: badge) {
            HStack(spacing: 12) {
                if !payload.output.isEmpty {
                    toggle(showsOutput ? "출력 접기" : "출력 보기", isOn: $showsOutput)
                }
                if !payload.input.isEmpty {
                    toggle(showsInput ? "입력 접기" : "입력 보기", isOn: $showsInput)
                }
            }
            if showsOutput, !payload.output.isEmpty {
                ToolOutputBox(output: payload.output) { fullScreen = .output }
                if payload.truncated {
                    Text("출력 일부만 표시").font(.caption2).foregroundStyle(.secondary)
                }
            }
            if showsInput, !payload.input.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(inputJSON)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .padding(8)
                }
                .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
                .expandable { fullScreen = .input }
            }
        }
        .fullScreenCover(item: $fullScreen) { which in
            switch which {
            case .output:
                TextContentViewer(
                    title: payload.title, subtitle: String(localized: "도구 출력"),
                    content: .text(payload.output), truncated: payload.truncated
                )
            case .input:
                TextContentViewer(
                    title: payload.title, subtitle: String(localized: "도구 입력"),
                    content: .code(inputJSON, language: "json"), truncated: false
                )
            }
        }
    }

    private var badge: String? {
        guard let code = payload.exitCode, code != 0 else { return nil }
        return "exit \(code)"
    }

    private var inputJSON: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(payload.input) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    private func toggle(_ label: String, isOn: Binding<Bool>) -> some View {
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            Label(label, systemImage: isOn.wrappedValue ? "chevron.up" : "chevron.down")
                .font(.caption)
        }
        .buttonStyle(.borderless)
    }
}
