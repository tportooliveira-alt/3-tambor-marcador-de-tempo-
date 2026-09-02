// swift-tools-version:5.9
// Núcleo puro da fotocélula virtual (sem UIKit/AVFoundation): differencer, calibrador,
// estimador sub-quadro e máquina de estados. Testável com `swift test` em qualquer Mac.
import PackageDescription

let package = Package(
    name: "PhotocellCore",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "PhotocellCore", targets: ["PhotocellCore"]),
    ],
    targets: [
        .target(
            name: "PhotocellCore",
            path: "Sources/PhotocellCore"
        ),
        .testTarget(
            name: "PhotocellCoreTests",
            dependencies: ["PhotocellCore"],
            path: "Tests/PhotocellCoreTests"
        ),
    ]
)
