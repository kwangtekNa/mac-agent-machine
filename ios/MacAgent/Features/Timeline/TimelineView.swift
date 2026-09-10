import SwiftUI

/// step 5 가 채우는 타임라인 화면의 자리표시자. 세션 제목과 상태만 보여준다.
struct TimelineView: View {
    @Environment(SessionsStore.self) private var store
    let sessionId: String

    var body: some View {
        Group {
            if let session = store.session(id: sessionId) {
                ContentUnavailableView {
                    Label(session.displayTitle, systemImage: "bubble.left.and.text.bubble.right")
                } description: {
                    Text("\(session.agent.displayName) · \(session.status.label)\n타임라인은 곧 제공됩니다.")
                }
            } else {
                ContentUnavailableView("세션을 찾을 수 없습니다", systemImage: "questionmark.circle")
            }
        }
        .navigationTitle(store.session(id: sessionId)?.displayTitle ?? String(localized: "세션"))
        .navigationBarTitleDisplayMode(.inline)
    }
}
