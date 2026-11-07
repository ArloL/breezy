#if !canImport(Darwin)
import Foundation

/// The part of Foundation's UndoManager that BoardModel uses, which swift-corelibs-foundation lacks.
public final class UndoManager {
  private struct Group {
    var actions: [() -> Void] = []
    var name = ""
  }
  private var undos: [Group] = [], redos: [Group] = [], open: Group?
  private var depth = 0
  public private(set) var isUndoing = false, isRedoing = false
  /// Only false, as BoardModel sets it: grouping by the run loop's events is not modelled, and Foundation's would undo
  /// several groups of one event as one.
  public var groupsByEvent = true {
    didSet { precondition(!groupsByEvent, "this UndoManager does not group by event") }
  }
  public var levelsOfUndo = 0

  public init() {}

  public var canUndo: Bool { !undos.isEmpty }
  public var canRedo: Bool { !redos.isEmpty }
  public var undoActionName: String { undos.last?.name ?? "" }
  public var redoActionName: String { redos.last?.name ?? "" }

  public func beginUndoGrouping() {
    if depth == 0 { open = Group() }
    depth += 1
  }

  public func endUndoGrouping() {
    depth -= 1
    guard depth == 0, let g = open else { return }
    open = nil
    guard !g.actions.isEmpty else { return }
    if isUndoing {
      redos.append(g)
    } else {
      undos.append(g)
      if levelsOfUndo > 0, undos.count > levelsOfUndo { undos.removeFirst(undos.count - levelsOfUndo) }
      if !isRedoing { redos.removeAll() }
    }
  }

  public func registerUndo<Target: AnyObject>(withTarget target: Target, handler: @escaping (Target) -> Void) {
    precondition(open != nil, "registerUndo outside a group")
    open!.actions.append { [unowned target] in handler(target) }
  }

  public func setActionName(_ name: String) { open?.name = name }

  public func undo() {
    guard let g = undos.popLast() else { return }
    run(g, undoing: true)
  }

  public func redo() {
    guard let g = redos.popLast() else { return }
    run(g, undoing: false)
  }

  public func removeAllActions() {
    undos.removeAll()
    redos.removeAll()
  }

  private func run(_ g: Group, undoing: Bool) {
    if undoing { isUndoing = true } else { isRedoing = true }
    defer { isUndoing = false; isRedoing = false }
    beginUndoGrouping()
    open!.name = g.name
    g.actions.reversed().forEach { $0() }
    endUndoGrouping()
  }
}
#endif
