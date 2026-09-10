import Foundation
import Observation
import os

/// 승인 응답 전송 상태. 확정은 서버의 `approval.resolved` 이며 낙관적으로 pending 을 바꾸지 않는다.
enum ApprovalSubmitState: Equatable, Sendable {
    case idle
    case submitting(approvalId: String)
    case failed(approvalId: String, message: String)
}

/// 세션 화면의 상태(IOS.md 6절). `apply(_:)` 가 유일한 변경 경로이며 뷰는 상태만 읽는다.
/// REST `GET /sessions/:id` 로 초기 아이템을 받은 뒤 `since=lastSeq` 로 소켓에 붙고, 스냅샷은 REST 결과와 합친다.
@MainActor
@Observable
final class TimelineModel {
    typealias SocketFactory = @MainActor (_ sessionId: String, _ since: Int) -> SessionSocket

    let sessionId: String
    private(set) var session: Session?
    /// seq 오름차순.
    private(set) var items: [TimelineItem] = []
    /// requestedAt 오름차순.
    private(set) var pendingApprovals: [Approval] = []
    private(set) var status: SessionStatus = .starting
    private(set) var mode: SessionMode = .ask
    /// snapshot / REST 의 `truncated`.
    private(set) var hasOlderHistory = false
    /// recoverable 오류. `transientErrorDuration` 뒤 nil.
    private(set) var transientError: String?
    /// recoverable == false 또는 status == .error.
    private(set) var fatalError: String?
    private(set) var lastSeq = 0
    private(set) var isSending = false
    private(set) var socket: SessionSocket?
    /// 승인 응답 전송 상태(step 6). `submitting` 동안 해당 승인의 버튼은 비활성.
    private(set) var approvalSubmit: ApprovalSubmitState = .idle
    /// snapshot 처리 직후부터 첫 라이브 이벤트 전까지 true. 재생으로 들어온 승인 요청에는 햅틱을 울리지 않는다.
    private(set) var isReplaying = false

    var socketState: SessionSocket.State { socket?.state ?? .idle }

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let socketFactory: SocketFactory
    @ObservationIgnored private let transientErrorDuration: Duration
    @ObservationIgnored private let approvalFailureDuration: Duration
    @ObservationIgnored private let haptics: any HapticsProviding
    @ObservationIgnored private var approvalFailureTask: Task<Void, Never>?
    @ObservationIgnored private var indexById: [String: Int] = [:]
    @ObservationIgnored private var pumpTask: Task<Void, Never>?
    @ObservationIgnored private var transientTask: Task<Void, Never>?
    @ObservationIgnored private let logger = Logger(subsystem: "dev.mam.MacAgent", category: "TimelineModel")

    init(
        sessionId: String,
        client: APIClient,
        transientErrorDuration: Duration = .seconds(3),
        approvalFailureDuration: Duration = .seconds(2),
        haptics: (any HapticsProviding)? = nil,
        socketFactory: SocketFactory? = nil
    ) {
        self.sessionId = sessionId
        self.client = client
        self.transientErrorDuration = transientErrorDuration
        self.approvalFailureDuration = approvalFailureDuration
        self.haptics = haptics ?? SystemHaptics()
        let baseURL = client.baseURL
        self.socketFactory = socketFactory ?? { id, since in
            SessionSocket(baseURL: baseURL, sessionId: id, since: since)
        }
    }

    // MARK: - 수명

    /// REST 로 초기 items 를 읽고 `since=lastSeq` 로 소켓을 연다. REST 실패는 배너로 남기고 소켓은 그대로 연다(스냅샷이 채운다).
    func start() async {
        do {
            let detail = try await client.session(id: sessionId)
            applySession(detail.session)
            hasOlderHistory = detail.truncated
            for item in detail.items.sorted(by: { $0.seq < $1.seq }) { upsert(item) }
            lastSeq = max(lastSeq, detail.session.lastSeq, items.last?.seq ?? 0)
            fatalError = detail.session.status == .error ? (fatalError ?? ErrorMessages.sessionError) : nil
        } catch {
            if Task.isCancelled { return }
            fatalError = ErrorMessages.message(for: error)
        }
        if Task.isCancelled { return }
        connectSocket()
    }

    /// 소켓 종료(백그라운드 전환, 화면 이탈).
    func stop() {
        pumpTask?.cancel()
        pumpTask = nil
        socket?.disconnect()
        socket = nil
    }

    /// `since=lastSeq` 로 다시 접속한다. 놓친 이벤트는 재생된다.
    func resume() {
        stop()
        connectSocket()
    }

    private func connectSocket() {
        let socket = socketFactory(sessionId, lastSeq)
        self.socket = socket
        let stream = socket.events
        pumpTask = Task { [weak self] in
            for await event in stream {
                guard let self, !Task.isCancelled else { return }
                self.apply(event)
            }
        }
        socket.connect()
    }

    // MARK: - 이벤트 적용

    /// 유일한 변경 경로. `seq <= lastSeq` 인 이벤트(재생 중복)는 무시하되 `seq == 0`(snapshot, pong)은 예외.
    func apply(_ event: ServerEvent) {
        let seq = event.seq
        if seq > 0 {
            guard seq > lastSeq else { return }
            lastSeq = seq
            isReplaying = false
        }
        switch event {
        case .sessionSnapshot(let e):
            applySnapshot(e)
        case .itemStarted(let e), .itemCompleted(let e):
            upsert(e.item)
        case .itemDelta(let e):
            applyDelta(e)
        case .approvalRequested(let e):
            pendingApprovals.removeAll { $0.approvalId == e.approval.approvalId }
            pendingApprovals.append(e.approval)
            pendingApprovals.sort { $0.requestedAt < $1.requestedAt }
            status = .waitingApproval
            session?.status = .waitingApproval
            if !isReplaying { haptics.warning() }
        case .approvalResolved(let e):
            pendingApprovals.removeAll { $0.approvalId == e.approvalId }
            resolveApprovalItem(approvalId: e.approvalId, optionId: e.optionId, by: e.by, at: e.ts)
            reconcileSubmitState()
        case .sessionStatus(let e):
            status = e.status
            mode = e.mode
            session?.status = e.status
            session?.mode = e.mode
            fatalError = e.status == .error ? (e.reason ?? ErrorMessages.sessionError) : nil
        case .sessionUsage(let e):
            // 누적 사용량·컨텍스트만 갱신한다. 아이템·상태는 바뀌지 않는다.
            session?.usage = e.usage
        case .turnCompleted:
            break
        case .error(let e):
            // 응답 전송 중에 온 error 는 그 승인에 대한 거절(이미 처리됨 등)로 본다. 문구는 배너가 보여준다.
            if case .submitting(let id) = approvalSubmit {
                failApproval(id, alreadyResolved: true)
                if !e.recoverable { fatalError = e.message }
            } else if e.recoverable {
                showTransient(ErrorMessages.socketErrorMessage(e.message))
            } else {
                fatalError = e.message
            }
        case .pong:
            break
        }
    }

    private func applySnapshot(_ e: SessionSnapshotEvent) {
        applySession(e.session)
        hasOlderHistory = e.truncated
        for item in e.items.sorted(by: { $0.seq < $1.seq }) { upsert(item) }
        pendingApprovals = e.pendingApprovals.sorted { $0.requestedAt < $1.requestedAt }
        lastSeq = max(lastSeq, e.session.lastSeq, e.items.map(\.seq).max() ?? 0)
        fatalError = e.session.status == .error ? (fatalError ?? ErrorMessages.sessionError) : nil
        isReplaying = true
        reconcileSubmitState()
    }

    private func applySession(_ s: Session) {
        session = s
        status = s.status
        mode = s.mode
    }

    /// 같은 id 는 제자리 교체, 아니면 seq 순서를 지켜 삽입(보통은 끝에 append).
    private func upsert(_ item: TimelineItem) {
        if let index = indexById[item.id] {
            items[index] = item
            return
        }
        if let last = items.last, last.seq > item.seq {
            let insertAt = items.firstIndex { $0.seq > item.seq } ?? items.count
            items.insert(item, at: insertAt)
            reindex()
        } else {
            items.append(item)
            indexById[item.id] = items.count - 1
        }
    }

    private func reindex() {
        indexById = Dictionary(uniqueKeysWithValues: items.enumerated().map { ($1.id, $0) })
    }

    private func applyDelta(_ e: ItemDeltaEvent) {
        guard let index = indexById[e.itemId] else {
            logger.debug("델타 대상 아이템 없음")
            return
        }
        var item = items[index]
        switch (e.field, item.payload) {
        case (.text, .assistantMessage(var p)):
            p.text += e.delta
            item.payload = .assistantMessage(p)
        case (.text, .reasoning(var p)):
            p.text += e.delta
            item.payload = .reasoning(p)
        case (.output, .toolCall(var p)):
            p.output += e.delta
            item.payload = .toolCall(p)
        case (.patch, .fileChange(var p)):
            p.patch += e.delta
            item.payload = .fileChange(p)
        default:
            logger.debug("델타 필드와 아이템 종류 불일치")
            return
        }
        items[index] = item
    }

    private func resolveApprovalItem(approvalId: String, optionId: String, by: ApprovalResolvedBy, at: Date) {
        guard let index = items.firstIndex(where: {
            if case .approval(let p) = $0.payload { return p.approval.approvalId == approvalId }
            return false
        }), case .approval(var payload) = items[index].payload else { return }
        payload.resolution = ApprovalResolution(optionId: optionId, by: by, at: at)
        var item = items[index]
        item.payload = .approval(payload)
        item.status = .completed
        item.completedAt = at
        items[index] = item
    }

    private func showTransient(_ message: String) {
        transientError = message
        transientTask?.cancel()
        let duration = transientErrorDuration
        transientTask = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled else { return }
            self?.transientError = nil
        }
    }

    // MARK: - 승인

    /// 승인 응답. 소켓이 열려 있으면 `approval.respond`, 아니면 REST `POST /sessions/:id/approvals/:approvalId`.
    /// 확정은 서버의 `approval.resolved` 이벤트다(REST 200 도 마찬가지). pending 은 낙관적으로 바꾸지 않는다.
    /// 전송 중에는 다른 승인을 보내지 않는다.
    func respond(to approval: Approval, optionId: String, inputs: [String: String]? = nil, message: String? = nil) async {
        let id = approval.approvalId
        guard pendingApprovals.contains(where: { $0.approvalId == id }) else { return }
        if case .submitting = approvalSubmit { return }
        approvalFailureTask?.cancel()
        approvalSubmit = .submitting(approvalId: id)
        do {
            if let socket, socket.state == .open {
                try await socket.send(.approvalRespond(approvalId: id, optionId: optionId, inputs: inputs, message: message))
            } else {
                try await client.respondApproval(
                    sessionId: sessionId, approvalId: id,
                    ApprovalRespondRequest(optionId: optionId, inputs: inputs, message: message)
                )
            }
        } catch {
            // 기다리는 동안 resolved 가 먼저 왔으면 이미 idle 이다.
            guard approvalSubmit == .submitting(approvalId: id) else { return }
            failApproval(id, alreadyResolved: Self.isAlreadyResolved(error))
        }
    }

    /// `GET /sessions/:id` 로 세션·아이템을 다시 읽어 서버 상태와 맞춘다. 처리된 승인은 pending 에서 뺀다.
    /// `lastSeq` 는 올리지 않는다(REST 와 소켓 사이에 떠 있는 이벤트를 버리지 않도록).
    func refreshDetail() async {
        do {
            let detail = try await client.session(id: sessionId)
            applySession(detail.session)
            hasOlderHistory = detail.truncated
            for item in detail.items.sorted(by: { $0.seq < $1.seq }) { upsert(item) }
            fatalError = detail.session.status == .error ? (fatalError ?? ErrorMessages.sessionError) : nil
            if detail.session.pendingApprovals == 0 {
                pendingApprovals.removeAll()
            } else {
                let resolvedItemIds = Set(detail.items.compactMap { item -> String? in
                    if case .approval(let p) = item.payload, p.resolution != nil { return p.approval.itemId }
                    return nil
                })
                pendingApprovals.removeAll { resolvedItemIds.contains($0.itemId) }
            }
            reconcileSubmitState()
        } catch {
            if Task.isCancelled { return }
            logger.debug("세션 재조회 실패")
        }
    }

    /// 이미 처리됨(409/404, 소켓 error): 문구를 `approvalFailureDuration` 동안 보여준 뒤 pending 에서 빼고 서버 상태를 다시 읽는다.
    /// 전송 실패: 문구만 보여주고 pending 은 남긴다(다시 시도 가능).
    private func failApproval(_ id: String, alreadyResolved: Bool) {
        approvalSubmit = .failed(
            approvalId: id,
            message: alreadyResolved ? ErrorMessages.approvalAlreadyResolved : ErrorMessages.approvalSendFailed
        )
        approvalFailureTask?.cancel()
        let duration = approvalFailureDuration
        approvalFailureTask = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard let self, !Task.isCancelled else { return }
            if alreadyResolved {
                self.pendingApprovals.removeAll { $0.approvalId == id }
                await self.refreshDetail()
            }
            if case .failed(let failedId, _) = self.approvalSubmit, failedId == id {
                self.approvalSubmit = .idle
            }
        }
    }

    /// 전송 중인 승인이 더는 pending 에 없으면(누가 처리했든) 전송 상태를 정리한다.
    private func reconcileSubmitState() {
        guard case .submitting(let id) = approvalSubmit else { return }
        if !pendingApprovals.contains(where: { $0.approvalId == id }) {
            approvalSubmit = .idle
        }
    }

    nonisolated private static func isAlreadyResolved(_ error: any Error) -> Bool {
        guard case .server(let code, _, let status) = error as? APIError else { return false }
        return status == 409 || status == 404 || code == .conflict
    }

    // MARK: - 전송

    /// `turn.start`. 낙관적 `user_message` 는 그리지 않는다(서버가 보낸다). `running` 이면 보내지 않고 문구만.
    func send(text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard status != .running else {
            showTransient(ErrorMessages.agentBusy)
            return
        }
        guard let socket else {
            showTransient(ErrorMessages.sendFailed)
            return
        }
        isSending = true
        defer { isSending = false }
        do {
            try await socket.send(.turnStart(text: trimmed))
        } catch {
            showTransient(ErrorMessages.sendFailed)
        }
    }

    func interrupt() async {
        do {
            try await socket?.send(.turnInterrupt)
        } catch {
            showTransient(ErrorMessages.sendFailed)
        }
    }

    /// `session.setMode`. 모드 값은 서버의 `session.status` 로 돌아온다(낙관적 갱신 없음).
    func setMode(_ mode: SessionMode) async {
        do {
            try await socket?.send(.sessionSetMode(mode: mode))
        } catch {
            showTransient(ErrorMessages.sendFailed)
        }
    }
}
