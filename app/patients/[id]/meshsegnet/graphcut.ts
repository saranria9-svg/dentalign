// Binary (2-label: gingiva vs tooth) graph-cut via Dinic's max-flow
// algorithm. This computes the same global optimum as the Python
// reference's pygco-based refinement for a 2-class Potts-model energy —
// any correct max-flow algorithm finds a minimum cut of the same value, so
// the labeling quality is equivalent even though the solver (Dinic's, not
// Boykov-Kolmogorov like gco/pygco) differs. Dinic's was chosen over
// reimplementing BK because it's far simpler to get provably correct, and
// the graph is small enough (~10k nodes) that performance is not a concern
// either way.
//
// Standard binary graph-cut construction (Boykov-Jolly): source S =
// terminal for label 0, sink T = terminal for label 1. Edge (S,i) has
// capacity D_i(1) (cost of labeling i as 1), edge (i,T) has capacity
// D_i(0) — after min-cut, nodes still reachable from S end up on the
// source side (label 0), the rest are label 1.

export interface SmoothnessEdge {
  a: number;
  b: number;
  w: number;
}

class MaxFlowGraph {
  numNodes: number;
  head: Int32Array;
  next: number[] = [];
  to: number[] = [];
  cap: number[] = [];

  constructor(numNodes: number) {
    this.numNodes = numNodes;
    this.head = new Int32Array(numNodes).fill(-1);
  }

  addEdge(u: number, v: number, capUV: number, capVU = 0) {
    this.to.push(v); this.cap.push(capUV); this.next.push(this.head[u]); this.head[u] = this.to.length - 1;
    this.to.push(u); this.cap.push(capVU); this.next.push(this.head[v]); this.head[v] = this.to.length - 1;
  }

  maxflow(s: number, t: number): number {
    const { numNodes, head, next, to, cap } = this;
    const level = new Int32Array(numNodes);
    const it = new Int32Array(numNodes);
    let flow = 0;

    const bfs = (): boolean => {
      level.fill(-1);
      level[s] = 0;
      const queue = [s];
      let qi = 0;
      while (qi < queue.length) {
        const u = queue[qi++];
        for (let e = head[u]; e !== -1; e = next[e]) {
          if (cap[e] > 0 && level[to[e]] < 0) {
            level[to[e]] = level[u] + 1;
            queue.push(to[e]);
          }
        }
      }
      return level[t] >= 0;
    };

    const dfs = (u: number, pushed: number): number => {
      if (u === t || pushed === 0) return pushed;
      for (; it[u] !== -1; it[u] = next[it[u]]) {
        const e = it[u];
        const v = to[e];
        if (cap[e] > 0 && level[v] === level[u] + 1) {
          const d = dfs(v, Math.min(pushed, cap[e]));
          if (d > 0) {
            cap[e] -= d;
            cap[e ^ 1] += d;
            return d;
          }
        }
      }
      return 0;
    };

    while (bfs()) {
      for (let i = 0; i < numNodes; i++) it[i] = head[i];
      let pushed: number;
      // eslint-disable-next-line no-cond-assign
      while ((pushed = dfs(s, Infinity)) > 0) flow += pushed;
    }
    return flow;
  }

  reachableFromSource(s: number): Uint8Array {
    const { numNodes, head, next, to, cap } = this;
    const visited = new Uint8Array(numNodes);
    visited[s] = 1;
    const queue = [s];
    let qi = 0;
    while (qi < queue.length) {
      const u = queue[qi++];
      for (let e = head[u]; e !== -1; e = next[e]) {
        if (cap[e] > 0 && !visited[to[e]]) {
          visited[to[e]] = 1;
          queue.push(to[e]);
        }
      }
    }
    return visited;
  }
}

export function binaryGraphCut(
  numNodes: number,
  unary0: Float64Array,
  unary1: Float64Array,
  edges: SmoothnessEdge[]
): Uint8Array {
  const S = numNodes;
  const T = numNodes + 1;
  const g = new MaxFlowGraph(numNodes + 2);

  for (let i = 0; i < numNodes; i++) {
    g.addEdge(S, i, Math.max(0, Math.round(unary1[i])), 0);
    g.addEdge(i, T, Math.max(0, Math.round(unary0[i])), 0);
  }
  for (const { a, b, w } of edges) {
    const cw = Math.max(0, Math.round(w));
    g.addEdge(a, b, cw, cw);
  }

  g.maxflow(S, T);
  const sourceSide = g.reachableFromSource(S);
  const labels = new Uint8Array(numNodes);
  for (let i = 0; i < numNodes; i++) labels[i] = sourceSide[i] ? 0 : 1;
  return labels;
}
