"use client";

type FolderImporterProps = {
  onFilesLoaded: (files: File[]) => void;
};

export default function FolderImporter({
  onFilesLoaded,
}: FolderImporterProps) {
  return (
    <div style={{ marginBottom: 20 }}>
      <p>
        <strong>📂 Importer un dossier 3Shape</strong>
      </p>

      <input
        type="file"
        multiple
        webkitdirectory=""
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          onFilesLoaded(files);
        }}
      />
    </div>
  );
}