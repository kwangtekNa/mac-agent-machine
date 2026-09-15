import Foundation

/// 방 목록의 한 줄(IOS.md 10.12). 대화와 "지금 눌러야 하는 것"은 그대로 두고, 연속된 작업 카드만 한 셀로 접는다.
/// 묶기는 **화면 전용**이다: 서버·프로토콜·`RoomModel` 은 그대로이고 메시지는 하나도 사라지지 않는다.
enum RoomEntryGroup: Identifiable {
    /// 접지 않는 줄(대화 · 대기 중 승인 · 곁방 연결 카드).
    case single(RoomEntry)
    /// 연속된 작업 카드. `id` 는 첫 항목의 id 라 뒤에 메시지가 붙어도 바뀌지 않는다(펼침 상태가 유지된다).
    case work(id: String, entries: [RoomEntry], summary: WorkGroupSummary)

    var id: String {
        switch self {
        case .single(let entry): entry.id
        case .work(let id, _, _): id
        }
    }
}

/// 접힌 작업 셀의 머리 줄(순수). 종류별 개수와 등장한 팀원만 알면 문구가 정해진다.
struct WorkGroupSummary: Equatable {
    /// 해결된 승인 카드 수(대기 중은 묶지 않는다).
    let approvals: Int
    let changes: Int
    /// 시스템 공지 수(곁방 연결 카드는 묶지 않으므로 여기 없다).
    let systems: Int
    /// `status == .ready` 인 변경 카드 수. 사람이 머지를 눌러야 하는 건수다.
    let mergeReady: Int
    /// 등장 순서, 중복 제거. 팀원 목록에 없는 작성자는 빼고, 시스템 공지는 작성자가 없다.
    let memberNames: [String]

    init(approvals: Int, changes: Int, systems: Int, mergeReady: Int, memberNames: [String]) {
        self.approvals = approvals
        self.changes = changes
        self.systems = systems
        self.mergeReady = mergeReady
        self.memberNames = memberNames
    }

    var total: Int { approvals + changes + systems }

    /// `작업 5건`. 한 종류면 그 종류로(`명령 3건` · `변경 2건` · `공지 4건`), 팀원이 한 명이면 이름을 앞에 붙인다(`지연 명령 3건`).
    var title: String {
        let body: String
        switch (approvals, changes, systems) {
        case (let a, 0, 0) where a > 0: body = String(localized: "명령 \(a)건")
        case (0, let c, 0) where c > 0: body = String(localized: "변경 \(c)건")
        case (0, 0, let s) where s > 0: body = String(localized: "공지 \(s)건")
        default: body = String(localized: "작업 \(total)건")
        }
        guard memberNames.count == 1, let name = memberNames.first else { return body }
        return "\(name) \(body)"
    }

    /// `명령 2 · 변경 2 · 공지 1`. 한 종류면 제목이 이미 다 말하므로 빈 문자열.
    var detail: String {
        counts.count > 1 ? counts.joined(separator: " · ") : ""
    }

    /// `머지 대기 N건`. 머지를 기다리는 변경이 없으면 캡슐도 없다.
    var badge: String? {
        mergeReady > 0 ? String(localized: "머지 대기 \(mergeReady)건") : nil
    }

    /// VoiceOver: "작업 5건, 명령 2 변경 2 공지 1, 머지 대기 1건".
    var accessibilityLabel: String {
        var parts = [title]
        if counts.count > 1 { parts.append(counts.joined(separator: " ")) }
        if let badge { parts.append(badge) }
        return parts.joined(separator: ", ")
    }

    private var counts: [String] {
        var parts: [String] = []
        if approvals > 0 { parts.append(String(localized: "명령 \(approvals)")) }
        if changes > 0 { parts.append(String(localized: "변경 \(changes)")) }
        if systems > 0 { parts.append(String(localized: "공지 \(systems)")) }
        return parts
    }
}

/// 연속된 작업 카드를 한 셀로 묶는다(순수, IOS.md 10.12). 서버 동작은 그대로이며 화면에서만 접는다.
enum RoomEntryGrouping {
    /// 연속된 묶기 대상만 묶는다(1건이어도 묶는다). 대기 중 승인·대화·곁방 연결 카드는 `single`.
    static func group(_ entries: [RoomEntry], members: [TeamMember]) -> [RoomEntryGroup] {
        var groups: [RoomEntryGroup] = []
        var run: [RoomEntry] = []

        func flush() {
            guard let first = run.first else { return }
            groups.append(.work(id: first.id, entries: run, summary: summary(of: run, members: members)))
            run = []
        }

        for entry in entries {
            if isGroupable(entry) {
                run.append(entry)
            } else {
                flush()
                groups.append(.single(entry))
            }
        }
        flush()
        return groups
    }

    /// 해결된 승인 · 변경 · (곁방이 아닌) 시스템 공지만 묶는다.
    /// 대기 중 승인은 사람이 눌러야 에이전트가 진행하고, 곁방 연결 카드는 그 방으로 들어가는 유일한 입구라 접지 않는다.
    static func isGroupable(_ entry: RoomEntry) -> Bool {
        switch entry {
        case .approval(let message): message.approval?.resolution != nil
        case .changes: true
        case .system(let message): message.sideRoom == nil
        case .sideRoom, .message: false
        }
    }

    private static func summary(of entries: [RoomEntry], members: [TeamMember]) -> WorkGroupSummary {
        var approvals = 0
        var changes = 0
        var systems = 0
        var mergeReady = 0
        var names: [String] = []

        for entry in entries {
            switch entry {
            case .approval: approvals += 1
            case .changes(let message):
                changes += 1
                if message.changes?.status == .ready { mergeReady += 1 }
            case .system: systems += 1
            case .sideRoom, .message: break
            }
            if let id = memberId(of: entry), let name = members.first(where: { $0.id == id })?.name, !names.contains(name) {
                names.append(name)
            }
        }
        return WorkGroupSummary(
            approvals: approvals, changes: changes, systems: systems, mergeReady: mergeReady, memberNames: names
        )
    }

    /// 카드의 주인. 미러링 payload 의 `memberId` 를 먼저 보고(작성자가 시스템인 기록도 있다) 없으면 작성자.
    private static func memberId(of entry: RoomEntry) -> String? {
        switch entry {
        case .approval(let message): message.approval?.memberId ?? message.author.memberId
        case .changes(let message): message.changes?.memberId ?? message.author.memberId
        case .system, .sideRoom, .message: entry.message.author.memberId
        }
    }
}
