import Foundation
import Observation

/// 앱에 로컬 저장하는 커스텀 역할 프리셋. 서버와 동기화하지 않는다(서버 API 없음).
/// 팀원 편집기의 "프리셋으로 저장"이 만들고, 역할 피커의 "내 프리셋" 섹션에 나온다.
struct LocalRolePreset: Codable, Identifiable, Hashable, Sendable {
    var id: UUID
    var label: String
    var emoji: String
    var prompt: String
    var mode: SessionMode

    init(id: UUID = UUID(), label: String, emoji: String, prompt: String, mode: SessionMode = .autoEdit) {
        self.id = id
        self.label = label
        self.emoji = emoji
        self.prompt = prompt
        self.mode = mode
    }
}

/// `UserDefaults` 에 JSON 으로 저장한다. 테스트는 suite 를 주입한다.
@MainActor
@Observable
final class RolePresetStore {
    static let defaultsKey = "rolePresets.v1"

    private(set) var presets: [LocalRolePreset] = []
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        presets = Self.load(from: defaults)
    }

    /// 같은 id 는 교체, 아니면 뒤에 추가.
    func save(_ preset: LocalRolePreset) {
        if let index = presets.firstIndex(where: { $0.id == preset.id }) {
            presets[index] = preset
        } else {
            presets.append(preset)
        }
        persist()
    }

    func remove(id: UUID) {
        presets.removeAll { $0.id == id }
        persist()
    }

    func preset(id: UUID) -> LocalRolePreset? {
        presets.first { $0.id == id }
    }

    private static func load(from defaults: UserDefaults) -> [LocalRolePreset] {
        guard let data = defaults.data(forKey: defaultsKey) else { return [] }
        return (try? JSONDecoder().decode([LocalRolePreset].self, from: data)) ?? []
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(presets) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}
