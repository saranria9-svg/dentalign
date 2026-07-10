// Computes a single, smoothly-varying tooth/gingiva transition height
// around the arch — a "margin line" — and returns which side of it each
// cell falls on. Frame-by-frame analysis of 3Shape's own ClearAligner
// staging renders (both the flat-shaded "physical model" style and the
// translucent "clinical scan" style) never shows more than one transition
// per tooth, on any tooth, including the last molars, and the transition
// height never jumps abruptly from one tooth to the next — it reads as one
// continuous scalloped curve, not independent per-cell labels.
//
// Our graph-cut alone (see segment.ts), even with strong pairwise
// smoothness, guarantees neither property. Two distinct failure modes were
// verified on real molars: (a) an occlusal fissure that geometrically
// resembles a cervical margin (see geometricPrior.ts) flips a cell back to
// "tooth" below a "gingiva" cell that's higher up — multiple transitions
// within one angular wedge of the arch; (b) a confidently-wrong ONNX
// region spanning a run of ~15-20 adjacent wedges (roughly 1-2 teeth wide)
// produces an internally-consistent single transition that's still far
// too high across that whole run — clean locally, but a sharp outlier
// against the arch as a whole.
//
// A first attempt detected and patched only the wedges that looked bad
// (multi-transition, or a height outlier against a small local window).
// It didn't hold up live: a small window's "neighbourhood" can be entirely
// inside a wide defect (nothing looks like an outlier against itself), and
// widening the window to be robust to that made it wide enough to also
// span genuinely different tooth types with naturally different margin
// heights, so it started flagging (and homogenising) most of the arch
// instead — verified live, made the result worse, not better.
//
// This version sidesteps that tension entirely: rather than deciding which
// wedges are "bad", it computes one number per wedge (the height splitting
// that wedge's own cells into tooth-above/gingiva-below at minimum unary
// cost) and runs it through a median filter wide enough to fully suppress
// a 1-2 tooth contiguous run — a median filter is provably robust to any
// contiguous run shorter than half its window, with no tolerance parameter
// to mis-tune, and it still tracks genuine tooth-to-tooth height variation
// at a coarser scale than the window. The result feeds into segment.ts as
// an additional prior nudge on the unary costs (like computeToothnessPrior
// but far more informed), not a post-hoc label patch — so the existing,
// already-validated graph-cut and island-cleanup steps stay the final
// decision makers and nothing here can regress a tooth that was already
// classified correctly.
import { computeBucketedHeights } from "./archBuckets";

function windowMedian(values: Float64Array, center: number, radius: number, bucketCount: number): number {
  const window: number[] = [];
  for (let d = -radius; d <= radius; d++) {
    const idx = ((center + d) % bucketCount + bucketCount) % bucketCount;
    const v = values[idx];
    if (!Number.isNaN(v)) window.push(v);
  }
  if (window.length === 0) return 0.5;
  window.sort((a, b) => a - b);
  const mid = Math.floor(window.length / 2);
  return window.length % 2 === 0 ? (window[mid - 1] + window[mid]) / 2 : window[mid];
}

/** 1 = margin line predicts "tooth" for this cell, 0 = "gingiva". */
export function computeMarginLinePrediction(
  nCells: number,
  unary0: Float64Array,
  unary1: Float64Array,
  bx: Float64Array,
  by: Float64Array,
  bz: Float64Array,
  bucketCount = 180,
  medianRadius = 18
): Uint8Array {
  const { bucketOf, heightFraction } = computeBucketedHeights(bx, by, bz, bucketCount);

  const wedgeCells: number[][] = Array.from({ length: bucketCount }, () => []);
  for (let i = 0; i < nCells; i++) wedgeCells[bucketOf[i]].push(i);

  // Best single-threshold height per wedge: the split (among that wedge's
  // cells, sorted by height) minimising the total unary cost of forcing
  // everything above it to "tooth" and everything below it to "gingiva".
  const optimalThreshold = new Float64Array(bucketCount).fill(NaN);
  for (let w = 0; w < bucketCount; w++) {
    const cells = wedgeCells[w];
    if (cells.length === 0) continue;
    cells.sort((a, b) => heightFraction[b] - heightFraction[a]); // tallest (tooth-ish) first
    const n = cells.length;

    const suffixGum = new Float64Array(n + 1);
    for (let i = n - 1; i >= 0; i--) suffixGum[i] = suffixGum[i + 1] + unary0[cells[i]];
    let prefixTooth = 0;
    let bestCost = suffixGum[0];
    let bestK = 0;
    for (let k = 1; k <= n; k++) {
      prefixTooth += unary1[cells[k - 1]];
      const cost = prefixTooth + suffixGum[k];
      if (cost < bestCost) {
        bestCost = cost;
        bestK = k;
      }
    }
    optimalThreshold[w] =
      bestK === 0
        ? heightFraction[cells[0]] + 0.05
        : bestK === n
          ? heightFraction[cells[n - 1]] - 0.05
          : (heightFraction[cells[bestK - 1]] + heightFraction[cells[bestK]]) / 2;
  }

  const finalThreshold = new Float64Array(bucketCount);
  for (let w = 0; w < bucketCount; w++) {
    finalThreshold[w] = windowMedian(optimalThreshold, w, medianRadius, bucketCount);
  }

  const prediction = new Uint8Array(nCells);
  for (let w = 0; w < bucketCount; w++) {
    for (const cell of wedgeCells[w]) {
      prediction[cell] = heightFraction[cell] >= finalThreshold[w] ? 1 : 0;
    }
  }
  return prediction;
}
