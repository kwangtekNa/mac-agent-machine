import SwiftUI

/// unified diff 한 줄의 분류. 뷰와 테스트가 같은 함수를 쓴다.
struct DiffLine: Identifiable, Equatable {
    enum Kind: Equatable {
        case added, removed, hunk, header, context
    }

    let id: Int
    let kind: Kind
    let text: String

    static func classify(_ line: String) -> Kind {
        if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff ") || line.hasPrefix("index ") {
            return .header
        }
        if line.hasPrefix("@@") { return .hunk }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        return .context
    }

    /// 줄 단위로 나눈다. 끝의 빈 줄(패치가 `\n` 으로 끝날 때)은 버린다.
    static func split(_ patch: String) -> [DiffLine] {
        var lines = patch.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.last == "" { lines.removeLast() }
        return lines.enumerated().map { DiffLine(id: $0.offset, kind: classify($0.element), text: $0.element) }
    }
}

/// unified diff 를 줄 단위 배경으로 그린다. monospaced, 가로 스크롤.
struct DiffTextView: View {
    let patch: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(DiffLine.split(patch)) { line in
                    Text(line.text.isEmpty ? " " : line.text)
                        .font(.caption.monospaced())
                        .foregroundStyle(line.kind == .hunk || line.kind == .header ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(background(for: line.kind))
                }
            }
        }
        .textSelection(.enabled)
    }

    private func background(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .added: return .green.opacity(0.15)
        case .removed: return .red.opacity(0.15)
        default: return .clear
        }
    }
}
