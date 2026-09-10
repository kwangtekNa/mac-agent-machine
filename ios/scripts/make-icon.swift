// 앱 아이콘 생성기. `swift ios/scripts/make-icon.swift [출력 경로]` 로 1024×1024 불투명 PNG 를 만든다.
// 디자인: 시스템 파랑(#0A84FF) 배경 위에 흰색 두꺼운 프롬프트 막대(▍)와 오른쪽 아래 흰 점(커서). 단순 도형만 쓴다(SF Symbols 없음).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
guard let context = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: colorSpace, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else {
    fatalError("CGContext 생성 실패")
}

// 배경: systemBlue(다크 변형 #0A84FF).
context.setFillColor(CGColor(colorSpace: colorSpace, components: [10.0 / 255, 132.0 / 255, 1, 1])!)
context.fill(CGRect(x: 0, y: 0, width: size, height: size))

// 프롬프트 막대: 둥근 세로 사각형. 좌우 중심보다 약간 왼쪽.
context.setFillColor(CGColor(colorSpace: colorSpace, components: [1, 1, 1, 1])!)
let bar = CGRect(x: 328, y: 292, width: 168, height: 440)
context.addPath(CGPath(roundedRect: bar, cornerWidth: 48, cornerHeight: 48, transform: nil))
context.fillPath()

// 커서 점: 막대 오른쪽 아래, 막대 아랫변에 맞춘다.
let dot = CGRect(x: 560, y: 292, width: 136, height: 136)
context.fillEllipse(in: dot)

guard let image = context.makeImage() else { fatalError("이미지 생성 실패") }
let outputPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "ios/MacAgent/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
let url = URL(fileURLWithPath: outputPath)
guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("출력 파일을 만들 수 없습니다: \(outputPath)")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("PNG 쓰기 실패") }
print("wrote \(outputPath) (\(size)x\(size))")
