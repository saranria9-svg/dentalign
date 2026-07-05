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
import { computeBucketedHeights } from "./archBuckets";

export function computeToothnessPrior(
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  normalZ: Float64Array,
  bucketCount = 48
): Float64Array {
  const { heightFraction } = computeBucketedHeights(bx, by, bz, bucketCount);
  const nCells = bx.length;
  const toothness = new Float64Array(nCells);
  for (let i = 0; i < nCells; i++) {
    const normalScore = Math.min(1, Math.max(0, normalZ[i] * 0.5 + 0.5));
    toothness[i] = 0.7 * heightFraction[i] + 0.3 * normalScore;
  }
  return toothness;
}
