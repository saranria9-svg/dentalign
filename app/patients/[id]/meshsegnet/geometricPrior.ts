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
//
// The bucket window has to stay wide (several teeth, not one) or this
// backfires on molars: a narrow window's "local slice" ends up spanning
// only a single tooth's own occlusal relief, so a fissure between two
// cusps — locally the lowest point *of that tooth*, but nowhere near the
// real gumline — reads as if it were near the cervical margin and gets
// nudged toward gingiva. A wide window's low point is instead the actual
// cervical margin/interdental papilla a few teeth over, so a fissure
// still scores as clearly tooth. The normal-orientation term is folded in
// gently for the same reason: a fissure's concave walls point sideways
// like real gum does, so it's only allowed to break a genuine tie, never
// to outweigh a cell height already puts solidly on the tooth side.
import { computeBucketedHeights } from "./archBuckets";

export function computeToothnessPrior(
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  normalZ: Float64Array,
  bucketCount = 12
): Float64Array {
  const { heightFraction } = computeBucketedHeights(bx, by, bz, bucketCount);
  const nCells = bx.length;
  const toothness = new Float64Array(nCells);
  for (let i = 0; i < nCells; i++) {
    const normalScore = Math.min(1, Math.max(0, normalZ[i] * 0.5 + 0.5));
    toothness[i] = 0.85 * heightFraction[i] + 0.15 * normalScore;
  }
  return toothness;
}
