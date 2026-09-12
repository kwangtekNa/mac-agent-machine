import SwiftUI

/// 도구 출력 상자(IOS.md 5.2 "출력 접힘"). monospaced, 가로·세로 스크롤, 최대 `maxHeight`.
/// 짧은 출력은 내용만큼만 차지하고 긴 출력은 `maxHeight` 안에서 스크롤된다.
/// 더블 탭 또는 오른쪽 위 펼침 버튼(`expandable`)으로 전체 화면 뷰어(`TextContentViewer`)를 연다.
///
/// 높이는 본문 텍스트를 측정해 `min(내용 높이, maxHeight)` 로 준다. `fixedSize(vertical:)` + `frame(maxHeight:)` 조합은
/// 쓰지 않는다. 이유: fixedSize 는 부모 제안을 무시하고 내용 전체 높이로 그려지므로 긴 출력이 상자 밖으로 넘쳐
/// 이웃 카드 위에 겹쳐 그려진다(SwiftUI 는 기본적으로 클리핑하지 않는다).
struct ToolOutputBox: View {
    static let maxHeight: CGFloat = 240

    let output: String
    /// 더블 탭 또는 펼침 버튼: 전체 화면 뷰어를 연다. nil 이면 펼침 없음.
    var onExpand: (() -> Void)? = nil
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        ScrollView([.horizontal, .vertical], showsIndicators: true) {
            Text(output)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .padding(8)
                .onGeometryChange(for: CGFloat.self) { proxy in
                    proxy.size.height
                } action: { height in
                    contentHeight = height
                }
        }
        .frame(height: min(contentHeight, Self.maxHeight))
        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
        .expandable(onExpand: onExpand)
    }
}
