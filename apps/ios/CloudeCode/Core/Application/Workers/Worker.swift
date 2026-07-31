/// A self-contained lifecycle-scoped unit of application work.
@MainActor
protocol Working: AnyObject {
    var isStarted: Bool { get }

    func start()
    func stop()
}

/// Base lifecycle implementation for application workers.
@MainActor
class Worker: Working {
    private(set) var isStarted: Bool = false

    func start() {
        guard !isStarted else { return }
        isStarted = true
        didStart()
    }

    func stop() {
        guard isStarted else { return }
        isStarted = false
        didStop()
    }

    func didStart() {}

    func didStop() {}
}

extension Array where Element == any Working {
    @MainActor
    func startAll() {
        forEach { $0.start() }
    }

    @MainActor
    func stopAll() {
        forEach { $0.stop() }
    }
}
