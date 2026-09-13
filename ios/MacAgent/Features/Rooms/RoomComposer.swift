import SwiftUI

/// 컴포저가 텍스트·방·팀원으로 계산하는 것(순수): 캡션, 제안 칩, 제안 적용·답장 삽입.
/// 그룹방에서만 의미가 있다(DM 은 멘션을 무시하므로 캡션도 제안도 없다).
struct RoomComposerState: Equatable {
    /// 그룹방·멘션 없음·텍스트 있음 → "팀장 민수에게 전달됩니다", 모르는 `@토큰` → "모르는 팀원 @xxx 는 무시됩니다"(우선).
    var caption: String?
    /// 텍스트 끝 `@토큰` 에 맞는 팀원(`MentionParser.suggestions`).
    var suggestions: [TeamMember]
    var suggestionToken: Range<String.Index>?
    private var text: String

    static func make(text: String, room: Room?, members: [TeamMember], lead: TeamMember?) -> RoomComposerState {
        guard room?.kind == .group else {
            return RoomComposerState(caption: nil, suggestions: [], suggestionToken: nil, text: text)
        }
        let suggestion = MentionParser.suggestions(for: text, members: members)
        var caption: String?
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let unknown = MentionParser.unknownTokens(in: text, members: members)
            if !unknown.isEmpty {
                let list = unknown.map { "@\($0)" }.joined(separator: ", ")
                caption = String(localized: "모르는 팀원 \(list) 는 무시됩니다")
            } else {
                let mentions = MentionParser.mentions(in: text, members: members)
                if mentions.memberIds.isEmpty, !mentions.all, let lead {
                    caption = String(localized: "팀장 \(lead.name)에게 전달됩니다")
                }
            }
        }
        return RoomComposerState(
            caption: caption,
            suggestions: suggestion?.members ?? [],
            suggestionToken: suggestion?.token,
            text: text
        )
    }

    /// 제안 칩 탭: 토큰을 `@이름 ` 으로 바꾼 텍스트. 토큰이 없으면 nil.
    func applying(_ member: TeamMember) -> String? {
        guard let suggestionToken else { return nil }
        return MentionParser.apply(member, to: text, token: suggestionToken)
    }

    /// 컨텍스트 메뉴 "@이름에게 답장": 끝에 `@이름 ` 을 붙인다(앞이 비어 있지 않고 공백으로 끝나지 않으면 공백 하나를 넣는다).
    static func insertingReply(to member: TeamMember, into text: String) -> String {
        inserting("@\(member.name) ", into: text)
    }

    static func inserting(_ snippet: String, into text: String) -> String {
        guard let last = text.last else { return snippet }
        if last.isWhitespace || last.isNewline { return text + snippet }
        return text + " " + snippet
    }
}

/// 방 컴포저: 캡션 → 제안 칩 → 1~6줄 입력 + 보내기. 정지 버튼은 없다(중단은 상태 줄이 팀 전체를 맡는다).
/// 소켓이 닫혀 있어도 `RoomModel.send` 가 REST 로 보내므로 비활성화하지 않는다. `transientError` 는 캡션 자리에 잠깐 보인다.
struct RoomComposer: View {
    let model: RoomModel
    /// 바깥에서 삽입할 텍스트(`@이름 ` 답장). 소비하면 nil 로 되돌린다.
    @Binding var insertRequest: String?
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        let state = RoomComposerState.make(text: text, room: model.room, members: model.members, lead: model.lead)
        VStack(alignment: .leading, spacing: 6) {
            if let error = model.transientError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .accessibilityLabel("오류: \(error)")
            } else if let caption = state.caption {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("room.composer.caption")
            }
            if case .reconnecting = model.socketState {
                Text("다시 연결 중…").font(.caption).foregroundStyle(.secondary)
            }
            if !state.suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(state.suggestions) { member in
                            Button {
                                if let applied = state.applying(member) { text = applied }
                            } label: {
                                MemberChip(member: member, compact: true)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityIdentifier("room.mention.\(member.id)")
                        }
                    }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField("메시지", text: $text, axis: .vertical)
                    .accessibilityIdentifier("room.composer.input")
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
                .accessibilityLabel("보내기")
                .accessibilityIdentifier("room.composer.send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
        .onChange(of: insertRequest) { _, request in
            guard let request else { return }
            text = RoomComposerState.inserting(request, into: text)
            focused = true
            insertRequest = nil
        }
    }

    /// 보낸 뒤 오류가 없으면 비운다. 사용자 메시지는 서버의 `room.message` 로 돌아온다(낙관적 삽입 없음).
    private func send() {
        let outgoing = text
        Task {
            await model.send(text: outgoing)
            if model.transientError == nil, text == outgoing { text = "" }
        }
    }
}
