import SwiftUI

/// 파일 변경: 파일 목록(펼침) + "변경 내용" 토글(diff, 접힘). diff 를 더블 탭하면 전체 화면 뷰어.
struct FileChangeCard: View {
    let item: TimelineItem
    let payload: FileChangePayload
    @State private var showsDiff = false
    @State private var showsFullDiff = false

    private var title: String {
        String(localized: "파일 \(payload.files.count)개 변경")
    }

    var body: some View {
        ItemCard(item: item, style: ItemStyle.style(for: item), title: title) {
            ForEach(Array(payload.files.enumerated()), id: \.offset) { _, file in
                FileChangeRow(file: file)
            }
            if !payload.patch.isEmpty {
                DisclosureGroup("변경 내용", isExpanded: $showsDiff) {
                    DiffTextView(patch: payload.patch)
                        .padding(.top, 4)
                        .expandable { showsFullDiff = true }
                }
                .font(.caption)
            }
        }
        .fullScreenCover(isPresented: $showsFullDiff) {
            TextContentViewer(title: title, subtitle: String(localized: "변경 내용"), content: .diff(payload.patch), truncated: false)
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

/// 파일 한 행: kind 아이콘 + 경로(monospaced, 가운데 말줄임) + `+N −M`. 타임라인 `FileChangeCard` 와 방의 "변경 준비됨" 카드가 같이 쓴다.
struct FileChangeRow: View {
    let file: FileChangeEntry

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: FileChangeCard.symbol(for: file.kind))
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
}
