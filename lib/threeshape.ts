// Parses a folder imported from 3Shape (or any intraoral scanner export)
// selected via <input webkitdirectory>, and classifies its files into
// upper-jaw / lower-jaw STL meshes, JSON metadata, and texture images.
//
// 3Shape folders don't follow one single naming convention across scanner
// versions, so we match on common French/English hints found in filenames
// rather than relying on a single exact name.
//
// ClearAligner exports additionally split the case into "Subsetup1",
// "Subsetup2", ... "SubsetupN" subfolders — one per treatment stage, each
// with its own upper/lower STL pair — so those are detected and returned
// as an ordered `stages` list alongside the existing single upper/lower
// fields (which keep pointing at the root scan, or the last stage, for
// any caller that doesn't care about staging).

export interface ThreeShapeStage {
  label: string;
  upper: File | null;
  lower: File | null;
}

export interface ThreeShapeImportResult {
  upper: File | null;
  lower: File | null;
  metadata: File | null;
  textures: File[];
  others: File[];
  warnings: string[];
  stages: ThreeShapeStage[];
}

const UPPER_HINTS = [
  "upper",
  "maxillary",
  "maxill",
  "haut",
  "superieur",
  "sup",
  "arcadesup",
  "arcade_sup",
  "top",
  "u_scan",
  "_u.",
  "-u.",
];

const LOWER_HINTS = [
  "lower",
  "mandibular",
  "mandib",
  "bas",
  "inferieur",
  "inf",
  "arcadeinf",
  "arcade_inf",
  "bottom",
  "l_scan",
  "_l.",
  "-l.",
];

const IGNORED_FILENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

// Matches a folder name ending in "Subsetup" followed by its stage number,
// e.g. "04-03-2024_12-05-44_Subsetup1", "Subsetup12". Case-insensitive
// since scanner software versions differ in capitalization.
const SUBSETUP_PATTERN = /Subsetup(\d+)\s*$/i;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function matchesHint(name: string, hints: string[]): boolean {
  const normalized = normalize(name);
  return hints.some((hint) => normalized.includes(hint));
}

function extensionOf(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? (parts.pop() as string) : "";
}

// Immediate parent folder name of a file selected via <input
// webkitdirectory>, e.g. for "Case/Subsetup1/Maxillary.stl" this returns
// "Subsetup1". Empty string for files directly at the root of the
// selected folder.
function parentFolderName(file: File): string {
  const relativePath = file.webkitRelativePath || file.name;
  const parts = relativePath.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

// Pairs up a flat list of STL files into upper/lower, using the same
// hint-matching (and order-based fallback) rules regardless of whether
// they come from the root of the folder or from one Subsetup subfolder.
function classifyJawFiles(files: File[]): { upper: File | null; lower: File | null } {
  let upper: File | null = null;
  let lower: File | null = null;
  const unclassified: File[] = [];

  for (const file of files) {
    if (!upper && matchesHint(file.name, UPPER_HINTS)) {
      upper = file;
    } else if (!lower && matchesHint(file.name, LOWER_HINTS)) {
      lower = file;
    } else {
      unclassified.push(file);
    }
  }

  // Fallback for scanners that don't hint upper/lower in the filename:
  // assign remaining STL files in the order they were read.
  for (const file of unclassified) {
    if (!upper) {
      upper = file;
    } else if (!lower) {
      lower = file;
    }
  }

  return { upper, lower };
}

export function classifyThreeShapeFolder(files: File[]): ThreeShapeImportResult {
  const result: ThreeShapeImportResult = {
    upper: null,
    lower: null,
    metadata: null,
    textures: [],
    others: [],
    warnings: [],
    stages: [],
  };

  const rootStlFiles: File[] = [];
  // Subsetup number -> STL files found directly inside that Subsetup folder.
  const subsetupFiles = new Map<number, File[]>();

  for (const file of files) {
    const lowerName = file.name.toLowerCase();
    if (IGNORED_FILENAMES.has(lowerName)) continue;

    const ext = extensionOf(file.name);

    if (ext === "stl") {
      const folder = parentFolderName(file);
      const match = folder.match(SUBSETUP_PATTERN);
      if (match) {
        const stageNumber = parseInt(match[1], 10);
        const list = subsetupFiles.get(stageNumber);
        if (list) list.push(file);
        else subsetupFiles.set(stageNumber, [file]);
      } else {
        rootStlFiles.push(file);
      }
    } else if (ext === "json") {
      if (!result.metadata || file.size > result.metadata.size) {
        result.metadata = file;
      }
    } else if (["jpg", "jpeg", "png", "bmp", "webp"].includes(ext)) {
      result.textures.push(file);
    } else {
      result.others.push(file);
    }
  }

  const rootPair = classifyJawFiles(rootStlFiles);

  const stages: ThreeShapeStage[] = [];
  if (rootPair.upper || rootPair.lower) {
    stages.push({ label: "Scan initial", upper: rootPair.upper, lower: rootPair.lower });
  }
  const sortedStageNumbers = Array.from(subsetupFiles.keys()).sort((a, b) => a - b);
  for (const stageNumber of sortedStageNumbers) {
    const pair = classifyJawFiles(subsetupFiles.get(stageNumber) as File[]);
    stages.push({ label: `Étape ${stageNumber}`, upper: pair.upper, lower: pair.lower });
  }
  result.stages = stages;

  // Keep `upper`/`lower` meaningful for any caller that only cares about a
  // single pair (e.g. displaying "last import" info): prefer the root scan,
  // otherwise fall back to the most advanced (last) staged pair.
  const fallbackPair = rootPair.upper || rootPair.lower ? rootPair : stages[stages.length - 1];
  result.upper = fallbackPair?.upper ?? null;
  result.lower = fallbackPair?.lower ?? null;

  if (!result.upper && !result.lower) {
    result.warnings.push("Aucun fichier STL détecté dans ce dossier.");
  } else if (!result.upper || !result.lower) {
    result.warnings.push(
      "Une seule arcade a été détectée dans ce dossier. Vérifiez qu'il contient bien les deux fichiers STL (maxillaire et mandibulaire)."
    );
  }
  if (stages.some((stage) => !stage.upper || !stage.lower)) {
    result.warnings.push(
      "Certaines étapes du traitement n'ont qu'une seule arcade détectée."
    );
  }

  return result;
}
