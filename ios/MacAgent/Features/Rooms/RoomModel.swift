import Foundation
import Observation
import os

/// 머지·거절 REST 전송 상태. 카드의 `changes.status` 확정은 서버(`room.message.updated` 또는 REST 응답의 ChangeSet)다.
enum MergeSubmitState: Equatable, Sendable {
    case idle
    case submitting(changeId: String)
    case failed(changeId: String, message: String)
}

/// 방 화면의 상태(PROTOCOL.md 6.3, IOS.md 6절 규칙을 방에 적용). `TimelineModel` 을 거울처럼 따르되 방 이벤트에 맞춘다.
/// `apply(_:)` 가 유일한 변경 경로이며 뷰는 상태만 읽는다. 사용자 메시지는 낙관적으로 넣지 않고 서버의 `room.message` 를 기다린다.
/// 승인 응답은 기존 세션 API(`POST /sessions/:id/approvals/:approvalId`), 머지·거절은 REST 이고 확정은 서버 값이다.
@MainActor
@Observable
final class RoomModel {
    typealias SocketFactory = @MainActor (_ teamId: String, _ roomId: String, _ since: Int) -> RoomSocket

    let teamId: String
    let roomId: String
    /// `GET /teams/:id` 의 rooms 또는 `GET /teams/:id/rooms/:roomId`·스냅샷의 room.
    private(set) var room: Room?
    /// `GET /teams/:id` 의 팀원. 상태는 `memberStates` 가 우선한다.
    private(set) var members: [TeamMember] = []
    /// seq 오름차순, id 로 교체.
    private(set) var entries: [RoomEntry] = []
    /// 방에 미러링된 대기 승인(requestedAt 오름차순). 배너·시트는 `ApprovalResponding.pendingApprovals`(`[Approval]`)로 본다.
    private(set) var pendingRoomApprovals: [RoomApproval] = []
    /// `room.snapshot`/`room.status` 의 `members[].state`.
    private(set) var memberStates: [String: TeamMemberState] = [:]
    private(set) var dispatch: DispatchState?
    private(set) var lastSeq = 0
    /// snapshot / REST 의 `truncated`.
    private(set) var hasOlderHistory = false
    /// recoverable 오류. `transientErrorDuration` 뒤 nil.
    private(set) var transientError: String?
    /// recoverable == false 또는 초기 REST 실패.
    private(set) var fatalError: String?
    private(set) var isSending = false
    /// snapshot 처리 직후부터 첫 라이브 이벤트 전까지 true. 재생으로 들어온 승인 요청에는 햅틱을 울리지 않는다.
    private(set) var isReplaying = false
    /// 승인 응답 전송 상태(`TimelineModel` 과 공유하는 타입).
    private(set) var approvalSubmit: ApprovalSubmitState = .idle
    private(set) var mergeSubmit: MergeSubmitState = .idle
    private(set) var socket: RoomSocket?

    var socketState: RoomSocket.State { socket?.state ?? .idle }
    var isGroup: Bool { room?.kind == .group }
    /// DM 방의 상대. 그룹방은 nil.
    var dmMember: TeamMember? {
        guard room?.kind == .dm, let id = room?.memberId else { return nil }
        return member(id: id)
    }
    var lead: TeamMember? { members.first { $0.isLead } }
    /// 컴포저 캡션용: 그룹방에서 멘션 없는 메시지는 팀장에게 간다.
    var leadName: String? { lead?.name }
    /// state running 또는 waiting_approval.
    var workingMembers: [TeamMember] {
        members.filter { [.running, .waitingApproval].contains(state(of: $0)) }
    }
    /// state queued.
    var queuedMembers: [TeamMember] {
        members.filter { state(of: $0) == .queued }
    }

    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let socketFactory: SocketFactory
    @ObservationIgnored private let transientErrorDuration: Duration
    @ObservationIgnored private let approvalFailureDuration: Duration
    @ObservationIgnored private let haptics: any HapticsProviding
    @ObservationIgnored private var indexById: [String: Int] = [:]
    @ObservationIgnored private var pumpTask: Task<Void, Never>?
    @ObservationIgnored private var transientTask: Task<Void, Never>?
    @ObservationIgnored private var approvalFailureTask: Task<Void, Never>?
    @ObservationIgnored private var mergeFailureTask: Task<Void, Never>?
    @ObservationIgnored private let logger = Logger(subsystem: "dev.mam.MacAgent", category: "RoomModel")

    init(
        teamId: String,
        roomId: String,
        client: APIClient,
        transientErrorDuration: Duration = .seconds(3),
        approvalFailureDuration: Duration = .seconds(2),
        haptics: (any HapticsProviding)? = nil,
        socketFactory: SocketFactory? = nil
    ) {
        self.teamId = teamId
        self.roomId = roomId
        self.client = client
        self.transientErrorDuration = transientErrorDuration
        self.approvalFailureDuration = approvalFailureDuration
        self.haptics = haptics ?? SystemHaptics()
        let baseURL = client.baseURL
        self.socketFactory = socketFactory ?? { teamId, roomId, since in
            RoomSocket(baseURL: baseURL, teamId: teamId, roomId: roomId, since: since)
        }
    }

    func member(id: String) -> TeamMember? {
        members.first { $0.id == id }
    }

    /// 방 이벤트 상태 → 디스패치 목록 → 팀 조회 시점의 상태 순으로 본다.
    private func state(of member: TeamMember) -> TeamMemberState {
        if let state = memberStates[member.id] { return state }
        if let dispatch {
            if dispatch.running.contains(where: { $0.memberId == member.id }) { return .running }
            if dispatch.queued.contains(where: { $0.memberId == member.id }) { return .queued }
        }
        return member.state
    }

    // MARK: - 수명

    /// `GET /teams/:id`(팀원·방) → `GET /teams/:id/rooms/:roomId`(최근 200) → `since=lastSeq` 로 소켓.
    /// REST 실패는 배너로 남기고 소켓은 그대로 연다(스냅샷이 채운다). `lastSeq` 는 메시지를 준 방 조회로만 올린다.
    func start() async {
        do {
            let detail = try await client.team(id: teamId)
            members = detail.team.members
            dispatch = detail.dispatch
            if let found = detail.team.rooms.first(where: { $0.id == roomId }) { room = found }
        } catch {
            if Task.isCancelled { return }
            fatalError = ErrorMessages.message(for: error)
        }
        do {
            let detail = try await client.room(teamId: teamId, roomId: roomId)
            applyDetail(detail)
            lastSeq = max(lastSeq, detail.room.lastSeq, detail.messages.map(\.seq).max() ?? 0)
            fatalError = nil
        } catch {
            if Task.isCancelled { return }
            fatalError = ErrorMessages.message(for: error)
        }
        if Task.isCancelled { return }
        connectSocket()
    }

    /// `GET /teams/:id` 로 팀원 목록을 다시 읽는다(팀원 시트에서 권한·모델·사고 수준을 바꾸거나 기억을 초기화한 뒤).
    /// 실패는 조용히 이전 값을 둔다(배너 없음). 상태는 `memberStates` 가 계속 우선한다.
    func reloadMembers() async {
        do {
            let detail = try await client.team(id: teamId)
            members = detail.team.members
        } catch {
            if Task.isCancelled { return }
            logger.debug("팀원 재조회 실패")
        }
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
        let socket = socketFactory(teamId, roomId, lastSeq)
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
    func apply(_ event: RoomEvent) {
        let seq = event.seq
        if seq > 0 {
            guard seq > lastSeq else { return }
            lastSeq = seq
            isReplaying = false
        }
        switch event {
        case .roomSnapshot(let e):
            applySnapshot(e)
        case .roomMessage(let e):
            upsert(e.message)
            if e.message.kind == .approval, let approval = e.message.approval, approval.resolution == nil {
                addPending(approval)
                if !isReplaying { haptics.warning() }
            }
        case .roomMessageUpdated(let e):
            upsert(e.message)
            if let approval = e.message.approval {
                if approval.resolution == nil {
                    addPending(approval)
                } else {
                    resolvePending(approvalId: approval.approval.approvalId)
                }
            }
            if let change = e.message.changes { clearMergeSubmit(changeId: change.id) }
        case .roomStatus(let e):
            dispatch = e.dispatch
            memberStates = Self.states(from: e.members)
        case .roomError(let e):
            if e.recoverable {
                showTransient(e.message)
            } else {
                fatalError = e.message
            }
        case .pong:
            break
        }
    }

    private func applySnapshot(_ e: RoomSnapshotEvent) {
        room = e.room
        dispatch = e.dispatch
        memberStates = Self.states(from: e.members)
        for message in e.messages.sorted(by: { $0.seq < $1.seq }) { upsert(message) }
        pendingRoomApprovals = e.pendingApprovals.sorted { $0.approval.requestedAt < $1.approval.requestedAt }
        lastSeq = max(lastSeq, e.room.lastSeq, e.messages.map(\.seq).max() ?? 0)
        hasOlderHistory = e.truncated
        isReplaying = true
        reconcileSubmitState()
    }

    /// REST 방 조회 반영. `lastSeq` 는 호출자가 정한다(재조회는 올리지 않는다).
    private func applyDetail(_ detail: RoomDetailResponse) {
        room = detail.room
        hasOlderHistory = detail.truncated
        for message in detail.messages.sorted(by: { $0.seq < $1.seq }) { upsert(message) }
    }

    private static func states(from members: [RoomMemberStatus]) -> [String: TeamMemberState] {
        Dictionary(members.map { ($0.memberId, $0.state) }, uniquingKeysWith: { _, last in last })
    }

    /// 같은 id 는 제자리 교체, 아니면 seq 순서를 지켜 삽입(보통은 끝에 append). `message.seq` 는 갱신돼도 원래 값이다.
    private func upsert(_ message: RoomMessage) {
        let entry = RoomEntry.make(message)
        if let index = indexById[entry.id] {
            entries[index] = entry
            return
        }
        if let last = entries.last, last.seq > entry.seq {
            let insertAt = entries.firstIndex { $0.seq > entry.seq } ?? entries.count
            entries.insert(entry, at: insertAt)
            reindex()
        } else {
            entries.append(entry)
            indexById[entry.id] = entries.count - 1
        }
    }

    private func reindex() {
        indexById = Dictionary(uniqueKeysWithValues: entries.enumerated().map { ($1.id, $0) })
    }

    private func addPending(_ approval: RoomApproval) {
        pendingRoomApprovals.removeAll { $0.approval.approvalId == approval.approval.approvalId }
        pendingRoomApprovals.append(approval)
        pendingRoomApprovals.sort { $0.approval.requestedAt < $1.approval.requestedAt }
    }

    private func resolvePending(approvalId: String) {
        pendingRoomApprovals.removeAll { $0.approval.approvalId == approvalId }
        switch approvalSubmit {
        case .submitting(let id) where id == approvalId, .failed(let id, _) where id == approvalId:
            approvalFailureTask?.cancel()
            approvalSubmit = .idle
        default:
            break
        }
    }

    private func clearMergeSubmit(changeId: String) {
        switch mergeSubmit {
        case .submitting(let id) where id == changeId, .failed(let id, _) where id == changeId:
            mergeFailureTask?.cancel()
            mergeSubmit = .idle
        default:
            break
        }
    }

    /// 전송 중인 승인이 더는 pending 에 없으면(누가 처리했든) 전송 상태를 정리한다.
    private func reconcileSubmitState() {
        guard case .submitting(let id) = approvalSubmit else { return }
        if !pendingRoomApprovals.contains(where: { $0.approval.approvalId == id }) {
            approvalSubmit = .idle
        }
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

    // MARK: - 전송

    /// 소켓이 열려 있으면 `room.send`, 아니면 REST `POST .../messages`. 사용자 메시지는 서버의 `room.message` 로 돌아온다.
    /// REST 201 의 메시지는 서버 확정값(id·seq)이라 바로 넣되 `lastSeq` 는 올리지 않는다(소켓 재생과 겹쳐도 id 로 교체된다).
    func send(text: String, attachments: [Attachment]? = nil) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isSending = true
        defer { isSending = false }
        do {
            if let socket, socket.state == .open {
                try await socket.send(.send(text: trimmed, attachments: attachments))
            } else {
                let response = try await client.postRoomMessage(
                    teamId: teamId, roomId: roomId, PostRoomMessageRequest(text: trimmed, attachments: attachments)
                )
                upsert(response.message)
            }
        } catch {
            showTransient(ErrorMessages.sendFailed)
        }
    }

    /// `room.interrupt`. `memberId` 생략 시 팀 전체.
    func interrupt(memberId: String?) async {
        do {
            try await socket?.send(.interrupt(memberId: memberId))
        } catch {
            showTransient(ErrorMessages.sendFailed)
        }
    }

    // MARK: - 승인 (기존 세션 API, PROTOCOL.md 6.3)

    /// 카드의 `approval.sessionId` 로 `POST /sessions/:id/approvals/:approvalId`. 방 소켓으로는 보내지 않는다.
    /// 확정은 서버의 `room.message.updated` 다. pending 은 낙관적으로 바꾸지 않고, 전송 중에는 다른 승인을 보내지 않는다.
    func respond(to approval: RoomApproval, optionId: String, inputs: [String: String]? = nil, message: String? = nil) async {
        let id = approval.approval.approvalId
        guard pendingRoomApprovals.contains(where: { $0.approval.approvalId == id }) else { return }
        if case .submitting = approvalSubmit { return }
        approvalFailureTask?.cancel()
        approvalSubmit = .submitting(approvalId: id)
        do {
            try await client.respondApproval(
                sessionId: approval.sessionId, approvalId: id,
                ApprovalRespondRequest(optionId: optionId, inputs: inputs, message: message)
            )
        } catch {
            // 기다리는 동안 updated 가 먼저 왔으면 이미 idle 이다.
            guard approvalSubmit == .submitting(approvalId: id) else { return }
            failApproval(id, alreadyResolved: Self.isAlreadyResolved(error))
        }
    }

    /// 이미 처리됨(409/404): 문구를 `approvalFailureDuration` 동안 보여준 뒤 pending 에서 빼고 방을 다시 읽는다.
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
                self.pendingRoomApprovals.removeAll { $0.approval.approvalId == id }
                await self.refreshDetail()
            }
            if case .failed(let failedId, _) = self.approvalSubmit, failedId == id {
                self.approvalSubmit = .idle
            }
        }
    }

    /// `GET /teams/:id/rooms/:roomId` 로 메시지를 다시 읽어 서버 상태와 맞춘다. 처리된 승인은 pending 에서 뺀다.
    /// `lastSeq` 는 올리지 않는다(REST 와 소켓 사이에 떠 있는 이벤트를 버리지 않도록).
    private func refreshDetail() async {
        do {
            let detail = try await client.room(teamId: teamId, roomId: roomId)
            applyDetail(detail)
            let resolved = Set(detail.messages.compactMap { message -> String? in
                guard let approval = message.approval, approval.resolution != nil else { return nil }
                return approval.approval.approvalId
            })
            pendingRoomApprovals.removeAll { resolved.contains($0.approval.approvalId) }
            reconcileSubmitState()
        } catch {
            if Task.isCancelled { return }
            logger.debug("방 재조회 실패")
        }
    }

    nonisolated private static func isAlreadyResolved(_ error: any Error) -> Bool {
        guard case .server(let code, _, let status) = error as? APIError else { return false }
        return status == 409 || status == 404 || code == .conflict
    }

    // MARK: - 머지·거절 (REST, PROTOCOL.md 6.2)

    /// `POST /teams/:id/changes/:changeId/merge`. 카드는 응답의 ChangeSet(서버 확정값) 또는 `room.message.updated` 로 바뀐다.
    func requestMerge(_ change: ChangeSet) async {
        await submitChange(change.id) { [client, teamId] in
            try await client.mergeChange(teamId: teamId, changeId: change.id).change
        }
    }

    /// `POST /teams/:id/changes/:changeId/dismiss`.
    func dismiss(_ change: ChangeSet) async {
        await submitChange(change.id) { [client, teamId] in
            try await client.dismissChange(teamId: teamId, changeId: change.id)
        }
    }

    private func submitChange(_ changeId: String, _ request: @Sendable () async throws -> ChangeSet) async {
        if case .submitting = mergeSubmit { return }
        mergeFailureTask?.cancel()
        mergeSubmit = .submitting(changeId: changeId)
        do {
            let confirmed = try await request()
            replaceChanges(confirmed)
            if mergeSubmit == .submitting(changeId: changeId) { mergeSubmit = .idle }
        } catch {
            // 기다리는 동안 updated 가 먼저 왔으면 이미 idle 이다.
            guard mergeSubmit == .submitting(changeId: changeId) else { return }
            failMerge(changeId, message: ErrorMessages.message(for: error))
        }
    }

    /// 해당 ChangeSet 을 담은 메시지(`messageId`)의 `changes` 를 서버 값으로 교체한다.
    private func replaceChanges(_ change: ChangeSet) {
        guard let index = indexById[change.messageId] else { return }
        var message = entries[index].message
        message.changes = change
        entries[index] = RoomEntry.make(message)
    }

    private func failMerge(_ changeId: String, message: String) {
        mergeSubmit = .failed(changeId: changeId, message: message)
        mergeFailureTask?.cancel()
        let duration = approvalFailureDuration
        mergeFailureTask = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard let self, !Task.isCancelled else { return }
            if case .failed(let failedId, _) = self.mergeSubmit, failedId == changeId {
                self.mergeSubmit = .idle
            }
        }
    }
}

// MARK: - ApprovalResponding (배너·시트 공용 인터페이스)

extension RoomModel: ApprovalResponding {
    /// 미러링된 승인을 `Approval` 로 펼친다(requestedAt 오름차순은 `pendingRoomApprovals` 가 유지한다).
    var pendingApprovals: [Approval] {
        pendingRoomApprovals.map(\.approval)
    }

    /// `approvalId` 로 `RoomApproval` 을 찾아 카드의 세션 API 로 보낸다. pending 에 없으면 아무것도 하지 않는다.
    func respond(to approval: Approval, optionId: String, inputs: [String: String]?, message: String?) async {
        guard let roomApproval = pendingRoomApprovals.first(where: { $0.approval.approvalId == approval.approvalId }) else { return }
        await respond(to: roomApproval, optionId: optionId, inputs: inputs, message: message)
    }

    /// 배너 제목 위 작성자 캡션: `emoji 이름 · 역할`. 승인이 pending 에 없거나 팀원을 모르면 nil.
    func authorLabel(for approval: Approval) -> String? {
        guard let roomApproval = pendingRoomApprovals.first(where: { $0.approval.approvalId == approval.approvalId }),
              let member = member(id: roomApproval.memberId)
        else { return nil }
        return "\(member.emoji) \(member.name) · \(member.roleLabel)"
    }
}
