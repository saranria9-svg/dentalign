"use client";

import { useRef, useState } from "react";
import { saveScan, type PatientFileRecord, type ScanStage } from "@/lib/db";
import { classifyThreeShapeFolder } from "@/lib/threeshape";

type FolderImporterProps = {
  patientId: string;
  onImported: (record: PatientFileRecord) => void;
};

type Status = "idle" | "loading" | "error" | "done";

export default function FolderImporter({
  patientId,
  onImported,
}: FolderImporterProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string>("");

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    setStatus("loading");
    setMessage("Analyse du dossier…");

    const result = classifyThreeShapeFolder(files);

    if (!result.upper && !result.lower) {
      setStatus("error");
      setMessage(
        result.warnings[0] ?? "Aucun fichier STL trouvé dans ce dossier."
      );
      return;
    }

    let metadataContent: string | undefined;
    if (result.metadata) {
      try {
        metadataContent = await result.metadata.text();
      } catch {
        metadataContent = undefined;
      }
    }

    const stages: ScanStage[] | undefined =
      result.stages.length > 0
        ? result.stages.map((stage) => ({
            label: stage.label,
            upper: stage.upper ? { name: stage.upper.name, blob: stage.upper } : null,
            lower: stage.lower ? { name: stage.lower.name, blob: stage.lower } : null,
          }))
        : undefined;

    const record: PatientFileRecord = {
      patientId,
      upper: result.upper
        ? { name: result.upper.name, blob: result.upper }
        : null,
      lower: result.lower
        ? { name: result.lower.name, blob: result.lower }
        : null,
      metadata:
        result.metadata && metadataContent !== undefined
          ? { name: result.metadata.name, content: metadataContent }
          : null,
      textures: result.textures.map((t) => ({ name: t.name, blob: t })),
      importedAt: new Date().toISOString(),
      stages,
    };

    try {
      await saveScan(record);
      onImported(record);
      setStatus("done");
      setMessage(
        result.warnings.length > 0
          ? result.warnings[0]
          : stages && stages.length > 1
            ? `${stages.length} étapes de traitement détectées et importées.`
            : "Modèles 3D importés avec succès."
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Erreur lors de l'import du dossier."
      );
    }

    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 p-6 text-center transition hover:border-blue-400 hover:bg-blue-50/40">
      <input
        ref={inputRef}
        type="file"
        multiple
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <p className="text-2xl">📂</p>
      <p className="mt-2 text-sm font-medium text-slate-700">
        Importer un dossier 3Shape
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Sélectionnez le dossier exporté (STL maxillaire &amp; mandibulaire,
        JSON, textures)
      </p>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={status === "loading"}
        className="mt-4 inline-flex items-center rounded-full bg-blue-600 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "loading" ? "Import en cours…" : "Choisir un dossier"}
      </button>
      {message && (
        <p
          className={`mt-3 text-xs ${
            status === "error" ? "text-red-600" : "text-slate-500"
          }`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
