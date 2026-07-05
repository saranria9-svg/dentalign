// A lightweight per-cell geometric "toothness" prior, used only to nudge
// the graph-cut's unary costs — never to override a confident ONNX
// prediction. MeshSegNet's own confidence is weakest on the labial/incisal
// side of anterior teeth (flat, low-curvature surface right next to the
// gumline), which is exactly where gingiva is observed bleeding onto
// several teeth. Height within the local arch cross-section (the same
// dominant signal dentalColoring.ts uses for its procedural fallback,
// which on its own was too coarse to stand in for real segmentation) is a
// cheap, deterministic anchor for that ambiguous region: cells near the
// top of their local slice are anatomically almost always tooth.
export function computeToothnessPrior(
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  normalZ: Float64Array,
  bucketCount = 48
): Float64Array {
  const nCells = bx.length;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < nCells; i++) {
    cx += bx[i];
    cy += by[i];
  }
  cx /= nCells;
  cy /= nCells;

  const bucketMin = new Float64Array(bucketCount).fill(Infinity);
  const bucketMax = new Float64Array(bucketCount).fill(-Infinity);
  const bucketCounts = new Int32Array(bucketCount);
  const bucketOf = new Int32Array(nCells);

  let globalMinZ = Infinity;
  let globalMaxZ = -Infinity;
  for (let i = 0; i < nCells; i++) {
    const angle = Math.atan2(by[i] - cy, bx[i] - cx);
    const bucket = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor(((angle + Math.PI) / (2 * Math.PI)) * bucketCount))
    );
    bucketOf[i] = bucket;
    const z = bz[i];
    if (z < bucketMin[bucket]) bucketMin[bucket] = z;
    if (z > bucketMax[bucket]) bucketMax[bucket] = z;
    bucketCounts[bucket]++;
    if (z < globalMinZ) globalMinZ = z;
    if (z > globalMaxZ) globalMaxZ = z;
  }
  const globalRange = Math.max(globalMaxZ - globalMinZ, 1e-6);

  const toothness = new Float64Array(nCells);
  for (let i = 0; i < nCells; i++) {
    const bucket = bucketOf[i];
    // Sparse buckets give a noisy min/max; fall back to the whole arch's
    // height range for those (same guard as dentalColoring.ts).
    const useLocalBucket =
      bucketCounts[bucket] >= 6 && bucketMax[bucket] - bucketMin[bucket] > globalRange * 0.05;
    const lo = useLocalBucket ? bucketMin[bucket] : globalMinZ;
    const hi = useLocalBucket ? bucketMax[bucket] : globalMaxZ;
    const heightScore = Math.min(1, Math.max(0, (bz[i] - lo) / Math.max(hi - lo, 1e-6)));
    const normalScore = Math.min(1, Math.max(0, normalZ[i] * 0.5 + 0.5));
    toothness[i] = 0.7 * heightScore + 0.3 * normalScore;
  }
  return toothness;
}
