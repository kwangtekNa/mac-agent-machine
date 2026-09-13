import Foundation
import Observation

/// 폰에서 고른 디렉토리가 git 저장소가 아닐 때 그 자리에서 초기화하는 흐름(PROTOCOL.md 1절 `POST /git/init`).
/// 새 팀 시트와 디렉토리 피커가 같은 모델을 쓴다. 초기화는 항상 `dryRun` 미리보기 → 확인 다이얼로그 → 실제 초기화 순서다
/// (기존 파일 전부가 첫 커밋에 담기는 되돌리기 어려운 동작이라 확인 없이 초기화하지 않는다).
struct GitInitFlow: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        /// 확인 전이거나 이미 저장소다(아무것도 보여주지 않는다).
        case idle
        case checking
        case notRepo
        case previewing
        /// `dryRun` 결과를 확인 다이얼로그에 보여주는 중.
        case confirming(GitInitResponse)
        case initializing
        case done(GitInitResponse)
        case failed(String)

        /// 아직 저장소가 아니어서 팀을 만들 수 없는 상태(초기화 진행 중 포함). `failed` 는 서버가 최종 판단하도록 막지 않는다.
        var needsInit: Bool {
            switch self {
            case .notRepo, .previewing, .confirming, .initializing: return true
            case .idle, .checking, .done, .failed: return false
            }
        }

        /// 미리보기·초기화 요청이 진행 중(버튼 비활성).
        var isBusy: Bool {
            self == .previewing || self == .initializing
        }

        /// 확인 다이얼로그에 보여줄 미리보기. `confirming` 일 때만 값.
        var preview: GitInitResponse? {
            if case .confirming(let preview) = self { return preview }
            return nil
        }
    }

    var phase: Phase = .idle

    /// 확인 다이얼로그 본문. "파일 12개 · 47 KB를 첫 커밋에 담습니다. 기본 .gitignore 를 만듭니다."
    /// `.gitignore` 가 이미 있으면 마지막 문장을 생략하고, 파일이 없으면 "빈 저장소를 만듭니다".
    static func confirmMessage(_ preview: GitInitResponse) -> String {
        var sentences: [String] = []
        if preview.files == 0 {
            sentences.append(String(localized: "빈 저장소를 만듭니다."))
        } else {
            sentences.append(String(localized: "파일 \(preview.files)개 · \(FileFormat.size(preview.bytes))를 첫 커밋에 담습니다."))
        }
        if preview.createdGitignore {
            sentences.append(String(localized: "기본 .gitignore 를 만듭니다."))
        }
        return sentences.joined(separator: " ")
    }

    /// 완료 문구. 브랜치는 서버가 정한 값(`main`)을 표시만 한다.
    static func doneMessage(_ result: GitInitResponse) -> String {
        String(localized: "git 저장소를 만들었습니다 (\(result.branch), 파일 \(result.files)개)")
    }
}

/// `GitInitFlow` 를 서버 호출로 진행시키는 모델. 시트·피커가 각자 하나씩 만든다.
@MainActor @Observable
final class GitInitModel {
    private(set) var flow = GitInitFlow()
    private let client: APIClient
    /// 마지막으로 요청을 시작한 경로. 경로가 바뀐 뒤 늦게 도착한 응답은 버린다.
    @ObservationIgnored private var currentCwd: String?

    init(client: APIClient) {
        self.client = client
    }

    /// `GET /git/status` 로 저장소 여부를 본다. 저장소면 `idle`, 아니면 `notRepo`, 실패는 `failed`. 빈 경로는 `idle`.
    func check(cwd: String) async {
        currentCwd = cwd
        guard !cwd.isEmpty else {
            flow.phase = .idle
            return
        }
        flow.phase = .checking
        switch await probe(cwd: cwd) {
        case .success(let isRepo): flow.phase = isRepo ? .idle : .notRepo
        case .failure(let message): flow.phase = .failed(message)
        case .stale: break
        }
    }

    /// `dryRun` 으로 커밋될 파일 수·크기를 받아 확인 다이얼로그를 띄운다.
    func preview(cwd: String) async {
        currentCwd = cwd
        flow.phase = .previewing
        do {
            let preview = try await client.initRepository(cwd: cwd, dryRun: true)
            guard currentCwd == cwd, !Task.isCancelled else { return }
            flow.phase = .confirming(preview)
        } catch {
            guard currentCwd == cwd, !Task.isCancelled else { return }
            flow.phase = .failed(ErrorMessages.gitInitMessage(for: error))
        }
    }

    /// 확인 다이얼로그를 닫았다(취소). 다시 "저장소 아님" 으로.
    func cancelPreview() {
        if case .confirming = flow.phase { flow.phase = .notRepo }
    }

    /// 실제 초기화. 409(이미 저장소)는 "이미 git 저장소입니다." 로 `failed` 한 뒤 상태를 다시 확인해, 그 사이 저장소가 됐으면 `idle` 로 돌린다.
    func confirm(cwd: String) async {
        currentCwd = cwd
        flow.phase = .initializing
        do {
            let result = try await client.initRepository(cwd: cwd)
            guard currentCwd == cwd, !Task.isCancelled else { return }
            flow.phase = .done(result)
        } catch {
            guard currentCwd == cwd, !Task.isCancelled else { return }
            flow.phase = .failed(ErrorMessages.gitInitMessage(for: error))
            guard Self.isConflict(error) else { return }
            if case .success(true) = await probe(cwd: cwd) {
                flow.phase = .idle
            }
        }
    }

    func reset() {
        currentCwd = nil
        flow = GitInitFlow()
    }

    // MARK: - 내부

    private enum Probe {
        case success(Bool)
        case failure(String)
        /// 경로가 바뀌었거나 취소돼 결과를 버린다.
        case stale
    }

    private func probe(cwd: String) async -> Probe {
        do {
            let status = try await client.gitStatus(cwd: cwd)
            guard currentCwd == cwd, !Task.isCancelled else { return .stale }
            return .success(status.isRepo)
        } catch {
            guard currentCwd == cwd, !Task.isCancelled else { return .stale }
            return .failure(ErrorMessages.fileAccessMessage(for: error))
        }
    }

    private static func isConflict(_ error: any Error) -> Bool {
        guard case .server(let code, _, let status) = error as? APIError else { return false }
        return status == 409 || code == .conflict
    }
}
