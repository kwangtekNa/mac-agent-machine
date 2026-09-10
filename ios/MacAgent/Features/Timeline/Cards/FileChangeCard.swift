import SwiftUI

/// 파일 변경: 파일 목록(펼침) + "변경 내용" 토글(diff, 접힘).
struct FileChangeCard: View {
    let item: TimelineItem
    let payload: FileChangePayload
    @State private var showsDiff = false

    var body: some View {
        ItemCard(item: item, style: ItemStyle.style(for: item), title: String(localized: "파일 \(payload.files.count)개 변경")) {
            ForEach(Array(payload.files.enumerated()), id: \.offset) { _, file in
                HStack(spacing: 6) {
                    Image(systemName: Self.symbol(for: file.kind))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    Text(file.path)
                        .font(.caption.monospaced())
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Text("+\(file.additions)").foregroundStyle(.green)
                    Text("−\(file.deletions)").foregroundStyle(.red)
                }
                .font(.caption)
            }
            if !payload.patch.isEmpty {
                DisclosureGroup("변경 내용", isExpanded: $showsDiff) {
                    DiffTextView(patch: payload.patch).padding(.top, 4)
                }
                .font(.caption)
            }
        }
    }

    static func symbol(for kind: FileChangeKind) -> String {
        switch kind {
        case .add: return "plus"
        case .modify: return "pencil"
        case .delete: return "minus"
        case .rename: return "arrow.right"
        case .unknown: return "questionmark"
        }
    }
}
