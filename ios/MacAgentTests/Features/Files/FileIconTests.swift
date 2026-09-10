import SwiftUI
import XCTest
@testable import MacAgent

final class FileIconTests: XCTestCase {
    func testTypes() {
        XCTAssertEqual(FileIcon.symbol(name: "src", type: .dir), "folder.fill")
        XCTAssertEqual(FileIcon.color(type: .dir), .blue)
        XCTAssertEqual(FileIcon.symbol(name: "current", type: .symlink), "link")
        XCTAssertEqual(FileIcon.symbol(name: "app.sock", type: .other), "questionmark.folder")
        XCTAssertEqual(FileIcon.symbol(name: "x", type: .unknown), "questionmark.folder")
        XCTAssertEqual(FileIcon.color(type: .file), .secondary)
    }

    func testFileExtensions() {
        for name in ["index.ts", "a.tsx", "b.js", "c.swift", "d.py", "e.json", "f.yml", "g.sh", "h.cpp", "i.plist"] {
            XCTAssertEqual(FileIcon.symbol(name: name, type: .file), "doc.text", name)
        }
        for name in ["a.png", "b.jpg", "c.jpeg", "d.gif", "e.webp", "f.heic", "g.svg"] {
            XCTAssertEqual(FileIcon.symbol(name: name, type: .file), "photo", name)
        }
        XCTAssertEqual(FileIcon.symbol(name: "README.md", type: .file), "doc.richtext")
        XCTAssertEqual(FileIcon.symbol(name: "NOTES.MARKDOWN", type: .file), "doc.richtext", "확장자는 대소문자 무시")
        XCTAssertEqual(FileIcon.symbol(name: "notes.txt", type: .file), "doc")
        XCTAssertEqual(FileIcon.symbol(name: "Makefile", type: .file), "doc")
        XCTAssertEqual(FileIcon.symbol(name: ".env", type: .file), "doc")
    }
}
