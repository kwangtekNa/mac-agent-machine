import QuickLook
import SwiftUI

/// 내려받은 원본 문서(PDF·Office 등)를 시스템 QuickLook 으로 보여준다(ADR-012: 새 패키지 없이 `QuickLook` 만).
/// push 된 뷰 안에 임베드하므로 닫기는 내비게이션 뒤로가기이고, 공유는 QuickLook 자체 툴바가 맡는다.
struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url
        controller.reloadData()
    }

    /// 항목 하나짜리 데이터 소스. `QLPreviewItem` 은 `NSURL` 이 그대로 만족한다.
    @MainActor
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) {
            self.url = url
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
            url as NSURL
        }
    }
}
