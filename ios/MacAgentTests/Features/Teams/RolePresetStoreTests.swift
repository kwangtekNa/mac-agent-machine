import Foundation
import XCTest
@testable import MacAgent

/// `RolePresetStore`: UserDefaults suite 주입, 저장·교체·삭제·왕복.
@MainActor
final class RolePresetStoreTests: XCTestCase {
    private var suiteName: String!
    private var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "RolePresetStoreTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testSaveRemoveAndRoundTrip() {
        let store = RolePresetStore(defaults: defaults)
        XCTAssertTrue(store.presets.isEmpty)

        let dba = LocalRolePreset(label: "DBA", emoji: "🗄️", prompt: "Own the schema.", mode: .plan)
        store.save(dba)
        store.save(LocalRolePreset(label: "QA", emoji: "🧪", prompt: "Test everything."))
        XCTAssertEqual(store.presets.map(\.label), ["DBA", "QA"])

        var renamed = dba
        renamed.label = "DB 관리자"
        store.save(renamed)
        XCTAssertEqual(store.presets.map(\.label), ["DB 관리자", "QA"], "같은 id 는 제자리 교체")
        XCTAssertEqual(store.preset(id: dba.id)?.label, "DB 관리자")

        let reloaded = RolePresetStore(defaults: defaults)
        XCTAssertEqual(reloaded.presets, store.presets, "새 인스턴스가 UserDefaults 에서 그대로 읽는다")
        XCTAssertEqual(reloaded.presets[0].mode, .plan)

        reloaded.remove(id: dba.id)
        XCTAssertEqual(reloaded.presets.map(\.label), ["QA"])
        XCTAssertEqual(RolePresetStore(defaults: defaults).presets.map(\.label), ["QA"])
        XCTAssertNotNil(defaults.data(forKey: RolePresetStore.defaultsKey))
    }

    func testCorruptDataYieldsEmptyList() {
        defaults.set(Data("nope".utf8), forKey: RolePresetStore.defaultsKey)
        XCTAssertTrue(RolePresetStore(defaults: defaults).presets.isEmpty)
    }
}
