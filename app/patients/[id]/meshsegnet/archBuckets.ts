// Shared angular-bucket height-fraction helper: slices the arch into
// `bucketCount` angular wedges around its own centroid, then expresses each
// cell's height (Z) as a 0..1 fraction of its local wedge's height range
// (falling back to the whole arch's range for sparse wedges). Used both as
// a geometric prior nudging MeshSegNet's own uncertain cells
// (geometricPrior.ts) and, more importantly, as the stable per-wedge
// coordinate that a tooth/gum boundary learned on one stage
// (gumProfile.ts) can be re-applied to on every other stage — it only
// depends on each stage's own local geometry, so it transfers even though
// stages don't share one fixed coordinate frame.
export interface BucketedHeights {
  bucketOf: Int32Array;
  heightFraction: Float64Array;
  /** Continuous 0..1 angular position around the arch (bucketOf is this, discretized). */
  angleFraction: Float64Array;
}

export function computeBucketedHeights(
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  bucketCount: number
): BucketedHeights {
  const n = bx.length;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += bx[i];
    cy += by[i];
  }
  cx /= n;
  cy /= n;

  const bucketMin = new Float64Array(bucketCount).fill(Infinity);
  const bucketMax = new Float64Array(bucketCount).fill(-Infinity);
  const bucketCounts = new Int32Array(bucketCount);
  const bucketOf = new Int32Array(n);
  const angleFraction = new Float64Array(n);

  let globalMinZ = Infinity;
  let globalMaxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const angle = Math.atan2(by[i] - cy, bx[i] - cx);
    const af = (angle + Math.PI) / (2 * Math.PI);
    angleFraction[i] = af;
    const bucket = Math.min(bucketCount - 1, Math.max(0, Math.floor(af * bucketCount)));
    bucketOf[i] = bucket;
    const z = bz[i];
    if (z < bucketMin[bucket]) bucketMin[bucket] = z;
    if (z > bucketMax[bucket]) bucketMax[bucket] = z;
    bucketCounts[bucket]++;
    if (z < globalMinZ) globalMinZ = z;
    if (z > globalMaxZ) globalMaxZ = z;
  }
  const globalRange = Math.max(globalMaxZ - globalMinZ, 1e-6);

  const heightFraction = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const bucket = bucketOf[i];
    const useLocalBucket =
      bucketCounts[bucket] >= 6 && bucketMax[bucket] - bucketMin[bucket] > globalRange * 0.05;
    const lo = useLocalBucket ? bucketMin[bucket] : globalMinZ;
    const hi = useLocalBucket ? bucketMax[bucket] : globalMaxZ;
    heightFraction[i] = Math.min(1, Math.max(0, (bz[i] - lo) / Math.max(hi - lo, 1e-6)));
  }
  return { bucketOf, heightFraction, angleFraction };
}
