import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { Upload, Tag, Camera, FolderDown, Loader2, CheckCircle2, AlertCircle, X, History, Info, Trash2, User } from "lucide-react";

import { classifyPhoto, type ClassifyResult } from "@/lib/classify-photo.functions";
import { saveZip, getZip, deleteZip, clearZips } from "@/lib/zip-store";

type JobRecord = {
  id: string;
  date: string;
  photographer: string;
  fileName: string;
  size: number;
  photos: number;
  teams: number;
  errors: number;
  folders: string[];
};

const HISTORY_KEY = "pixai_history";



export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PixAi · Organiza fotos de torneo por equipo con IA" },
      {
        name: "description",
        content:
          "Sube las fotos de un fotógrafo, la IA detecta las etiquetas y agrupa cada equipo en su carpeta. Descarga un ZIP listo.",
      },
      { property: "og:title", content: "PixAi · Organiza fotos por equipo" },
      {
        property: "og:description",
        content: "Clasifica automáticamente las fotos de un torneo por equipo y descarga las carpetas en un ZIP.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type PhotoStatus = "pending" | "processing" | "label" | "photo" | "error";

type Photo = {
  id: string;
  file: File;
  status: PhotoStatus;
  team?: string;
  category?: string;
  error?: string;
  groupKey?: string;
};

// Downscale image client-side before sending to AI.
async function fileToDownscaledDataUrl(file: File, maxDim = 512): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.65);
}

async function classifyWithRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : "";
      // Only rate limits and temporary server/network errors should be retried.
      if (/Error IA 4\d\d|créditos|402/i.test(msg) && !/429/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1) + Math.random() * 400));
    }
  }
  throw lastErr;
}

function cleanName(s: string) {
  return s
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function folderName(category: string, team: string) {
  return `${cleanName(category).toLowerCase()} ${cleanName(team).toUpperCase()}`;
}

function Index() {
  const classify = useServerFn(classifyPhoto);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [running, setRunning] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [progress, setProgress] = useState(0);
  const cancelRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [history, setHistory] = useState<JobRecord[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [photographer, setPhotographer] = useState("");


  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) setHistory(JSON.parse(raw) as JobRecord[]);
    } catch {
      /* ignore */
    }
  }, []);

  const saveHistory = useCallback((rec: JobRecord) => {
    setHistory((prev) => {
      const next = [rec, ...prev].slice(0, 20);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem(HISTORY_KEY);
      void clearZips();
    } catch {
      /* ignore */
    }
  }, []);

  const removeJob = useCallback((id: string) => {
    setHistory((prev) => {
      const next = prev.filter((j) => j.id !== id);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    void deleteZip(id).catch(() => {});
  }, []);

  const redownload = useCallback(async (job: JobRecord) => {
    try {
      const blob = await getZip(job.id);
      if (!blob) {
        alert("Este ZIP ya no está guardado en el navegador.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = job.fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      alert("No se pudo recuperar el ZIP.");
    }
  }, []);



  const onPick = useCallback((files: FileList | null) => {
    if (!files) return;
    const imgs = Array.from(files)
      .filter((f) => f.type.startsWith("image/"))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setPhotos(
      imgs.map((f, i) => ({
        id: `${i}-${f.name}`,
        file: f,
        status: "pending",
      })),
    );
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      onPick(e.dataTransfer.files);
    },
    [onPick],
  );

  const groups = useMemo(() => {
    const map = new Map<string, { team: string; category: string; count: number }>();
    let current: { team: string; category: string; key: string } | null = null;
    for (const p of photos) {
      if (p.status === "label" && p.team) {
        const team = p.team;
        const cat = p.category ?? "Sin_categoria";
        const key = `${cleanName(team)} ${cleanName(cat)}`;
        current = { team, category: cat, key };
        const g = map.get(key) ?? { team, category: cat, count: 0 };
        g.count += 1;
        map.set(key, g);
      } else if (p.status === "photo" && current) {
        const g = map.get(current.key) ?? {
          team: current.team,
          category: current.category,
          count: 0,
        };
        g.count += 1;
        map.set(current.key, g);
      }
    }
    return Array.from(map.entries()).map(([key, v]) => ({ key, ...v }));
  }, [photos]);

  const orphanCount = useMemo(() => {
    let seenLabel = false;
    let n = 0;
    for (const p of photos) {
      if (p.status === "label") seenLabel = true;
      else if (p.status === "photo" && !seenLabel) n += 1;
    }
    return n;
  }, [photos]);

  const start = async () => {
    if (!photos.length || running) return;
    setRunning(true);
    cancelRef.current = false;
    setProgress(0);

    const CONCURRENCY = 4;
    const total = photos.length;
    let next = 0;
    let done = 0;

    const worker = async () => {
      while (true) {
        if (cancelRef.current) return;
        const i = next++;
        if (i >= total) return;
        const p = photos[i];
        setPhotos((prev) => prev.map((x) => (x.id === p.id ? { ...x, status: "processing" } : x)));

        try {
          const dataUrl = await fileToDownscaledDataUrl(p.file);
          const res: ClassifyResult = await classifyWithRetry(() =>
            classify({ data: { imageBase64: dataUrl } }),
          );

          if (res.isLabel && res.team) {
            const category = res.category ?? "Sin_categoria";
            setPhotos((prev) =>
              prev.map((x) =>
                x.id === p.id
                  ? {
                      ...x,
                      status: "label",
                      team: res.team!,
                      category,
                      groupKey: folderName(category, res.team!),
                    }
                  : x,
              ),
            );
          } else {
            setPhotos((prev) =>
              prev.map((x) => (x.id === p.id ? { ...x, status: "photo" } : x)),
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Error";
          setPhotos((prev) =>
            prev.map((x) => (x.id === p.id ? { ...x, status: "error", error: msg } : x)),
          );
        }
        done++;
        setProgress(done);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()),
    );
    setRunning(false);
  };

  const stop = () => {
    cancelRef.current = true;
  };

  const reset = () => {
    setPhotos([]);
    setProgress(0);
  };

  const downloadZip = async () => {
    if (!photos.length) return;
    setZipping(true);
    try {
      // Build groups in memory first
      const groupMap = new Map<
        string,
        { category: string; team: string; files: { name: string; file: File }[] }
      >();
      let current: { team: string; category: string; key: string } | null = null;

      for (const p of photos) {
        if (p.status === "label" && p.team) {
          const category = p.category ?? "Sin_categoria";
          const team = p.team;
          current = { team, category, key: folderName(category, team) };
          const key = current.key;
          const g = groupMap.get(key) ?? { team, category, files: [] };
          g.files.push({ name: `_etiqueta_${p.file.name}`, file: p.file });
          groupMap.set(key, g);
        } else if (p.status === "photo") {
          if (current) {
            const key = folderName(current.category, current.team);
            const g = groupMap.get(key) ?? {
              team: current.team,
              category: current.category,
              files: [],
            };
            g.files.push({ name: p.file.name, file: p.file });
            groupMap.set(key, g);
          } else {
            const key = "_sin_etiqueta";
            const g = groupMap.get(key) ?? { team: key, category: "", files: [] };
            g.files.push({ name: p.file.name, file: p.file });
            groupMap.set(key, g);
          }
        } else if (p.status === "error") {
          const key = "_errores";
          const g = groupMap.get(key) ?? { team: key, category: "", files: [] };
          g.files.push({ name: p.file.name, file: p.file });
          groupMap.set(key, g);
        }
      }

      const entries = Array.from(groupMap.entries());

      const zip = new JSZip();
      for (const [key, g] of entries) {
        const folder = zip.folder(key)!;
        for (const f of g.files) {
          folder.file(f.name, f.file);
        }
      }
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "STORE",
      });

      const id = `${Date.now()}`;
      const who = cleanName(photographer) || "sin_fotografo";
      const fileName = `${who.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.zip`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      try {
        await saveZip(id, blob);
      } catch {
        /* el ZIP ya se descargó aunque no se pueda guardar */
      }

      saveHistory({
        id,
        date: new Date().toISOString(),
        photographer: photographer.trim() || "Sin nombre",
        fileName,
        size: blob.size,
        photos: photos.length,
        teams: entries.filter(([k]) => !k.startsWith("_")).length,
        errors: photos.filter((p) => p.status === "error").length,
        folders: entries.map(([k]) => k).filter((k) => !k.startsWith("_")),
      });



    } finally {
      setZipping(false);
    }
  };

  const labelsFound = photos.filter((p) => p.status === "label").length;
  const errors = photos.filter((p) => p.status === "error").length;
  const done = progress === photos.length && photos.length > 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Camera className="h-4 w-4" strokeWidth={2} />
            </div>
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight">PixAi</h1>
              <p className="text-xs text-muted-foreground">
                Fotos de torneo, ordenadas por equipo
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowHelp(true)}
            className="text-sm text-muted-foreground transition hover:text-foreground"
          >
            Cómo funciona
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16">
        {photos.length === 0 ? (
          <section>
            <div className="text-center">
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
                <Tag className="h-3 w-3" /> Clasificación con IA
              </span>
              <h2 className="mx-auto mt-6 max-w-3xl text-4xl md:text-6xl">
                Sube las fotos.
                <br />
                <span className="text-muted-foreground">La IA hace el resto.</span>
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground">
                Detecta las etiquetas con el nombre del equipo y la categoría, y agrupa
                automáticamente todas las fotos siguientes en una carpeta por equipo. Descarga
                un ZIP listo para entregar.
              </p>
            </div>

            <div className="mx-auto mt-12 max-w-3xl">
              <label className="mb-2 block text-sm font-medium" htmlFor="photographer">
                Nombre del fotógrafo
              </label>
              <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
                <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                <input
                  id="photographer"
                  value={photographer}
                  onChange={(e) => setPhotographer(e.target.value)}
                  placeholder="Ej. Daniel"
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>

            <div
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => inputRef.current?.click()}
              className="group soft mx-auto mt-4 max-w-3xl cursor-pointer rounded-2xl border border-dashed border-border bg-card p-12 text-center transition hover:border-foreground/30"
            >
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-foreground transition group-hover:bg-primary group-hover:text-primary-foreground">
                <Upload className="h-5 w-5" />
              </div>
              <p className="text-base font-medium">Arrastra las fotos aquí</p>
              <p className="mt-1 text-sm text-muted-foreground">
                o haz clic para seleccionarlas. Se ordenan automáticamente por nombre.
              </p>
              <input
                ref={inputRef}
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => onPick(e.target.files)}
              />
            </div>

            <div data-history-section className="mx-auto mt-14 max-w-3xl">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-muted-foreground" />
                  <h3 className="text-sm font-semibold">Trabajos anteriores</h3>
                </div>
                {history.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="flex items-center gap-1 text-xs text-muted-foreground transition hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" /> Borrar todo
                  </button>
                )}
              </div>
              {history.length > 0 ? (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                  {history.map((job) => (
                    <li data-history-item key={job.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{job.photographer}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {new Date(job.date).toLocaleString("es-ES")} · {job.photos} fotos ·{" "}
                          {job.teams} equipos · {(job.size / 1048576).toFixed(1)} MB
                        </p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {job.fileName}
                        </p>
                      </div>
                      <button
                        onClick={() => redownload(job)}
                        className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition hover:bg-secondary"
                      >
                        <FolderDown className="h-3.5 w-3.5" /> ZIP
                      </button>
                      <button
                        onClick={() => removeJob(job.id)}
                        aria-label="Eliminar trabajo"
                        className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-xl border border-border bg-card px-4 py-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    Aún no hay trabajos guardados. Cuando proceses un lote, podrás volver a descargar el ZIP desde aquí.
                  </p>
                </div>
              )}
            </div>
          </section>

        ) : (
          <section className="space-y-6">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2.5">
              <User className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                value={photographer}
                onChange={(e) => setPhotographer(e.target.value)}
                placeholder="Nombre del fotógrafo"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">

              <div>
                <h2 className="text-2xl font-bold">{photos.length} fotos cargadas</h2>
                <p className="text-sm text-muted-foreground">
                  {labelsFound} equipos detectados · {errors} errores
                  {orphanCount > 0 && ` · ${orphanCount} sin etiqueta`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!running && !done && (
                  <button
                    onClick={start}
                    className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
                  >
                    Procesar con IA
                  </button>
                )}
                {running && (
                  <button
                    onClick={stop}
                    className="flex items-center gap-2 rounded-lg bg-destructive px-5 py-2.5 text-sm font-semibold text-destructive-foreground transition hover:opacity-90"
                  >
                    <X className="h-4 w-4" /> Detener
                  </button>
                )}
                {done && (
                  <button
                    onClick={downloadZip}
                    disabled={zipping}
                    className="flex items-center gap-2 rounded-lg bg-success px-5 py-2.5 text-sm font-semibold text-success-foreground transition hover:opacity-90 disabled:opacity-50"
                  >
                    {zipping ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FolderDown className="h-4 w-4" />
                    )}
                    Descargar ZIP
                  </button>
                )}
                <button
                  onClick={reset}
                  disabled={running}
                  className="rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-medium hover:bg-secondary disabled:opacity-50"
                >
                  Limpiar
                </button>
              </div>
            </div>

            {(running || done) && (
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {done ? "Completado" : "Procesando..."}
                  </span>
                  <span className="text-muted-foreground">
                    {progress} / {photos.length}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${(progress / photos.length) * 100}%` }}
                  />
                </div>
              </div>
            )}

            {groups.length > 0 && (
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Equipos detectados
                </h3>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {groups.map((g) => (
                    <div
                      key={g.key}
                      className="flex items-center justify-between rounded-lg border border-border bg-background/50 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{g.team}</p>
                        <p className="text-xs text-muted-foreground">{g.category}</p>
                      </div>
                      <span className="ml-2 shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
                        {g.count}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-border bg-card px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <span>Archivo</span>
                <span>Estado</span>
              </div>
              <ul className="max-h-[480px] divide-y divide-border overflow-y-auto">
                {photos.map((p) => (
                  <li
                    key={p.id}
                    className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs">{p.file.name}</p>
                      {p.status === "label" && p.team && (
                        <p className="mt-0.5 text-xs text-primary">
                          🏷️ {p.team} · {p.category}
                        </p>
                      )}
                      {p.status === "error" && (
                        <p className="mt-0.5 text-xs text-destructive">{p.error}</p>
                      )}
                    </div>
                    <StatusBadge status={p.status} />
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}
      </main>

      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/20 p-4 pt-24 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowHelp(false);
          }}
        >
          <div className="w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-[var(--shadow-soft)]">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Info className="h-4 w-4 text-primary" />
                <h3 className="text-base font-semibold">Cómo se usa</h3>
              </div>
              <button
                onClick={() => setShowHelp(false)}
                className="rounded-md p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                aria-label="Cerrar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <ol className="space-y-3 text-sm leading-relaxed text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">1.</span> Cada fotógrafo hace primero
                una foto a la etiqueta del equipo y después las fotos de ese equipo.
              </li>
              <li>
                <span className="font-medium text-foreground">2.</span> Sube todas las fotos de ese
                fotógrafo de una vez: se ordenan por nombre de archivo.
              </li>
              <li>
                <span className="font-medium text-foreground">3.</span> Pulsa «Procesar con IA»: se
                detectan las etiquetas y todo lo que va después pertenece a ese equipo.
              </li>
              <li>
                <span className="font-medium text-foreground">4.</span> Descarga el ZIP: una carpeta
                por equipo con el formato <code className="rounded bg-secondary px-1">categoría EQUIPO</code>.
              </li>
            </ol>

            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {[
                { icon: Upload, title: "Sube el lote", text: "Fotos de un fotógrafo, en orden." },
                { icon: Tag, title: "La IA clasifica", text: "Detecta etiquetas y extrae datos." },
                { icon: FolderDown, title: "Descarga el ZIP", text: "Carpetas listas para entregar." },
              ].map((s, i) => (
                <div key={s.title} className="text-left">
                  <div className="mb-2 flex items-center gap-2 text-muted-foreground">
                    <s.icon className="h-4 w-4" />
                    <span className="text-xs tabular-nums">0{i + 1}</span>
                  </div>
                  <h4 className="text-sm font-semibold">{s.title}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{s.text}</p>
                </div>
              ))}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => setShowHelp(false)}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:opacity-90"
              >
                Entendido
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: PhotoStatus }) {
  if (status === "pending")
    return <span className="text-xs text-muted-foreground">En cola</span>;
  if (status === "processing")
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Analizando
      </span>
    );
  if (status === "label")
    return (
      <span className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">
        <Tag className="h-3 w-3" /> Etiqueta
      </span>
    );
  if (status === "photo")
    return (
      <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-semibold text-success">
        <CheckCircle2 className="h-3 w-3" /> Foto
      </span>
    );
  return (
    <span className="flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive">
      <AlertCircle className="h-3 w-3" /> Error
    </span>
  );
}
