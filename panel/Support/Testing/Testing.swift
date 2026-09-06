import Darwin

@_silgen_name("openinstinct_panel_run_tests")
private func runOpenInstinctPanelTests() -> Int32

public func __swiftPMEntryPoint() async -> Never {
    exit(runOpenInstinctPanelTests())
}
