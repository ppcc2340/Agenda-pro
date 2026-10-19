/** Dependency graph helpers (F-03). Pure: edges in, verdict out. */
export interface DependencyEdges {
  /** taskId -> ids of the tasks it is blocked by. */
  blockedBy: ReadonlyMap<string, readonly string[]>;
}

/**
 * Returns the first cycle found as the list of task ids that form it (closed loop, first id repeated at the end),
 * or null when the graph is a DAG. Deterministic: nodes are visited in sorted order.
 */
export function findCycle(edges: DependencyEdges): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const nodes = [...new Set([...edges.blockedBy.keys(), ...[...edges.blockedBy.values()].flat()])].sort();

  const visit = (node: string): string[] | null => {
    const s = state.get(node);
    if (s === "done") return null;
    if (s === "visiting") {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const dep of [...(edges.blockedBy.get(node) ?? [])].sort()) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };

  for (const n of nodes) {
    const cycle = visit(n);
    if (cycle) return cycle;
  }
  return null;
}

/** Would replacing `taskId`'s blockedBy with `newBlockedBy` create a cycle? */
export function wouldCreateCycle(
  edges: DependencyEdges,
  taskId: string,
  newBlockedBy: readonly string[],
): string[] | null {
  if (newBlockedBy.includes(taskId)) return [taskId, taskId];
  const next = new Map(edges.blockedBy);
  next.set(taskId, newBlockedBy);
  return findCycle({ blockedBy: next });
}
