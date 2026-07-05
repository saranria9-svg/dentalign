"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import CabinetBadge from "@/components/Badge";
import ConfirmDialog from "@/components/ConfirmDialog";
import { deleteScan, getScan, type PatientFileRecord } from "@/lib/db";
import { formatBytes, formatDate } from "@/lib/format";
import { deletePatient, getPatient } from "@/lib/patients";
import type { Patient } from "@/lib/types";
import FolderImporter from "./FolderImporter";
import STLViewer, { type ScanStageInput } from "./STLViewer";

export default function PatientDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [patient, setPatient] = useState<Patient | null | undefined>(undefined);
  const [scan, setScan] = useState<PatientFileRecord | null>(null);
  const [stages, setStages] = useState<ScanStageInput[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const loadScan = useCallback(async () => {
    const record = await getScan(id);
    setScan(record ?? null);
    if (!record) {
      setStages([]);
      return;
    }
    // Multi-stage 3Shape imports (Subsetup1..N) already carry a `stages`
    // list; older single-scan imports don't, so synthesize a one-element
    // list from the top-level upper/lower pair — STLViewer always deals
    // with a stage array, no separate "no staging" code path.
    const sourceStages =
      record.stages && record.stages.length > 0
        ? record.stages
        : record.upper || record.lower
          ? [{ label: "Scan actuel", upper: record.upper, lower: record.lower }]
          : [];

    const converted = await Promise.all(
      sourceStages.map(async (stage) => ({
        label: stage.label,
        upperBuffer: stage.upper ? await stage.upper.blob.arrayBuffer() : null,
        lowerBuffer: stage.lower ? await stage.lower.blob.arrayBuffer() : null,
      }))
    );
    setStages(converted);
  }, [id]);

  useEffect(() => {
    setPatient(getPatient(id) ?? null);
    loadScan();
  }, [id, loadScan]);

  function handleImported() {
    loadScan();
  }

  async function handleDeletePatient() {
    deletePatient(id);
    await deleteScan(id);
    router.push("/patients");
  }

  if (patient === undefined) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10 text-sm text-slate-400">
        Chargement…
      </div>
    );
  }

  if (patient === null) {
    return (
      <div className="mx-auto max-w-5xl px-6 py-10">
        <p className="text-sm text-slate-500">Patient introuvable.</p>
        <Link
          href="/patients"
          className="mt-2 inline-block text-sm font-medium text-blue-600 hover:underline"
        >
          ← Retour à la liste
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <Link
        href="/patients"
        className="text-sm font-medium text-slate-500 hover:text-slate-700"
      >
        ← Retour aux patients
      </Link>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            {patient.prenom} {patient.nom}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <CabinetBadge cabinet={patient.cabinet} />
            <span className="text-xs text-slate-400">
              Dossier créé le {formatDate(patient.createdAt)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setConfirmingDelete(true)}
          className="rounded-full px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
        >
          Supprimer le patient
        </button>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-100 sm:grid-cols-3">
        <InfoItem label="Âge" value={patient.age !== null ? `${patient.age} ans` : "—"} />
        <InfoItem label="Traitement" value={patient.traitement || "—"} />
        <InfoItem label="Praticien" value={patient.praticien || "—"} />
        {patient.notes && (
          <div className="col-span-2 sm:col-span-3">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Notes
            </dt>
            <dd className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
              {patient.notes}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-8">
        <h2 className="text-base font-semibold text-slate-900">
          Modèles 3D
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Importez le dossier exporté depuis 3Shape pour afficher les arcades
          maxillaire et mandibulaire.
        </p>

        <div className="mt-4">
          <FolderImporter patientId={id} onImported={handleImported} />
        </div>

        <div className="mt-4">
          <STLViewer stages={stages} />
        </div>

        {scan && (
          <p className="mt-3 text-xs text-slate-400">
            Dernier import : {formatDate(scan.importedAt)}
            {scan.upper && ` · ${scan.upper.name} (${formatBytes(scan.upper.blob.size)})`}
            {scan.lower && ` · ${scan.lower.name} (${formatBytes(scan.lower.blob.size)})`}
            {scan.textures.length > 0 &&
              ` · ${scan.textures.length} texture${scan.textures.length > 1 ? "s" : ""}`}
            {scan.stages && scan.stages.length > 1 &&
              ` · ${scan.stages.length} étapes de traitement`}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title="Supprimer ce patient ?"
        description={`${patient.prenom} ${patient.nom} et ses scans 3D seront définitivement supprimés.`}
        confirmLabel="Supprimer"
        destructive
        onConfirm={handleDeletePatient}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="mt-1 text-sm text-slate-900">{value}</dd>
    </div>
  );
}
