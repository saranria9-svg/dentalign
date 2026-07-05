// 3-nearest-neighbour majority-vote upsampling of the decimated mesh's
// tooth/gingiva labels onto the original full-resolution mesh, using a
// uniform spatial grid for fast nearest-neighbour lookup (same technique
// as dentalColoring.ts's curvature pass).

class SpatialGrid {
  bx: Float64Array;
  by: Float64Array;
  bz: Float64Array;
  cellSize: number;
  buckets = new Map<number, number[]>();

  constructor(bx: Float64Array, by: Float64Array, bz: Float64Array, cellSize: number) {
    this.bx = bx; this.by = by; this.bz = bz;
    this.cellSize = cellSize;
    for (let i = 0; i < bx.length; i++) {
      const key = this.cellKey(bx[i], by[i], bz[i]);
      let arr = this.buckets.get(key);
      if (!arr) { arr = []; this.buckets.set(key, arr); }
      arr.push(i);
    }
  }

  cellCoord(v: number): number {
    return Math.floor(v / this.cellSize);
  }
  keyFromCoords(cx: number, cy: number, cz: number): number {
    // Pack 3 signed grid coords (assumed to fit comfortably in 18 bits
    // each, i.e. +/-131072 cells — ample for a mesh a few hundred mm across
    // at this cell size) into one integer for fast Map hashing.
    return (cx + 131072) * 4294967296 + (cy + 131072) * 262144 + (cz + 131072);
  }
  cellKey(x: number, y: number, z: number): number {
    return this.keyFromCoords(this.cellCoord(x), this.cellCoord(y), this.cellCoord(z));
  }

  kNearest(x: number, y: number, z: number, k: number, bestIdx: Int32Array, bestDist: Float64Array) {
    for (let i = 0; i < k; i++) { bestIdx[i] = -1; bestDist[i] = Infinity; }
    const cx0 = this.cellCoord(x), cy0 = this.cellCoord(y), cz0 = this.cellCoord(z);
    let found = 0;
    let radius = 1;
    while (found < k && radius < 50) {
      found = 0;
      for (let i = 0; i < k; i++) { bestIdx[i] = -1; bestDist[i] = Infinity; }
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dz = -radius; dz <= radius; dz++) {
            const key = this.keyFromCoords(cx0 + dx, cy0 + dy, cz0 + dz);
            const arr = this.buckets.get(key);
            if (!arr) continue;
            for (const i of arr) {
              const d = (this.bx[i] - x) ** 2 + (this.by[i] - y) ** 2 + (this.bz[i] - z) ** 2;
              if (d < bestDist[k - 1]) {
                let pos = k - 1;
                while (pos > 0 && bestDist[pos - 1] > d) {
                  bestDist[pos] = bestDist[pos - 1]; bestIdx[pos] = bestIdx[pos - 1];
                  pos--;
                }
                bestDist[pos] = d; bestIdx[pos] = i;
              }
              found++;
            }
          }
        }
      }
      radius++;
    }
  }
}

export function upsampleLabelsToFullRes(
  decBx: Float64Array,
  decBy: Float64Array,
  decBz: Float64Array,
  decLabels: Uint8Array,
  fullBx: Float64Array,
  fullBy: Float64Array,
  fullBz: Float64Array,
  k = 3
): Uint8Array {
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < decBx.length; i++) { if (decBx[i] < minX) minX = decBx[i]; if (decBx[i] > maxX) maxX = decBx[i]; }
  const span = Math.max(1e-3, maxX - minX);
  const cellSize = span / Math.max(4, Math.cbrt(decBx.length / 4));

  const grid = new SpatialGrid(decBx, decBy, decBz, cellSize);
  const fullLabels = new Uint8Array(fullBx.length);
  const bestIdx = new Int32Array(k), bestDist = new Float64Array(k);
  for (let i = 0; i < fullBx.length; i++) {
    grid.kNearest(fullBx[i], fullBy[i], fullBz[i], k, bestIdx, bestDist);
    let votes0 = 0, votes1 = 0;
    for (let j = 0; j < k; j++) {
      if (bestIdx[j] < 0) continue;
      if (decLabels[bestIdx[j]] === 0) votes0++; else votes1++;
    }
    fullLabels[i] = votes1 > votes0 ? 1 : 0;
  }
  return fullLabels;
}
