"use client";

// Lightweight IndexedDB wrapper used to store the 3D scan files (STL, JSON
// metadata, textures) attached to a patient. These files are frequently
// several megabytes each, which is far beyond what localStorage can hold
// (~5-10MB total), so they live in IndexedDB instead. Patient *metadata*
// (name, treatment, etc.) stays in localStorage via lib/patients.ts.

const DB_NAME = "mon-app-dentaire";
const DB_VERSION = 1;
const STORE_NAME = "scans";

export interface StoredFile {
  name: string;
  blob: Blob;
}

// One treatment stage (e.g. a 3Shape "SubsetupN" folder, or the initial
// scan) — a jaw pair like `upper`/`lower` below, just repeated per stage.
export interface ScanStage {
  label: string;
  upper: StoredFile | null;
  lower: StoredFile | null;
}

export interface PatientFileRecord {
  patientId: string;
  upper: StoredFile | null;
  lower: StoredFile | null;
  metadata: { name: string; content: string } | null;
  textures: StoredFile[];
  importedAt: string;
  // Present only when the imported folder had multiple treatment stages
  // (3Shape "Subsetup" subfolders). Additive field: records saved before
  // this existed simply don't have it, and every reader falls back to
  // `upper`/`lower` in that case — no DB version bump needed.
  stages?: ScanStage[];
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && "indexedDB" in window;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isBrowser()) {
      reject(new Error("IndexedDB n'est pas disponible dans cet environnement."));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "patientId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Erreur IndexedDB"));
  });
}

export async function saveScan(record: PatientFileRecord): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Erreur d'enregistrement"));
    });
  } finally {
    db.close();
  }
}

export async function getScan(
  patientId: string
): Promise<PatientFileRecord | undefined> {
  if (!isBrowser()) return undefined;
  const db = await openDb();
  try {
    return await new Promise<PatientFileRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(patientId);
      req.onsuccess = () => resolve(req.result as PatientFileRecord | undefined);
      req.onerror = () => reject(req.error ?? new Error("Erreur de lecture"));
    });
  } finally {
    db.close();
  }
}

export async function deleteScan(patientId: string): Promise<void> {
  if (!isBrowser()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(patientId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Erreur de suppression"));
    });
  } finally {
    db.close();
  }
}
