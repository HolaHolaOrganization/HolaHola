import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  ChevronDown,
  CircleAlert,
  Download,
  FileText,
  Fingerprint,
  Home,
  LockKeyhole,
  RefreshCw,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type RecordKind = "episode" | "story";

interface RecordMetadata {
  id: string;
  title: string;
  kind: RecordKind;
  episodeNumber: number | null;
  filename: string;
  recordedAt: string;
  bytes: number;
  parentId: string | null;
}

interface RecordDocument extends RecordMetadata {
  content: string;
  sha256: string;
}

interface CatalogResponse {
  records: RecordMetadata[];
  nextOffset: number | null;
}

interface DetailResponse {
  record: RecordDocument;
}

class RecordsRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RecordsRequestError";
    this.status = status;
  }
}

const CATALOG_KEY = ["/api/admin/central-records", 50] as const;
const PAGE_SIZE = 50;

function requestError(status: number, message: string) {
  return new RecordsRequestError(message || `Request failed (${status})`, status);
}

async function fetchCatalog(offset: number, signal?: AbortSignal): Promise<CatalogResponse> {
  const response = await fetch(`/api/admin/central-records?limit=${PAGE_SIZE}&offset=${offset}`, {
    credentials: "include",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw requestError(response.status, message);
  }
  return response.json() as Promise<CatalogResponse>;
}

async function fetchRecord(id: string, signal?: AbortSignal): Promise<RecordDocument> {
  const response = await fetch(`/api/admin/central-records/${encodeURIComponent(id)}`, {
    credentials: "include",
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw requestError(response.status, message);
  }
  const payload = (await response.json()) as DetailResponse;
  return payload.record;
}

function isDenied(error: unknown) {
  return error instanceof RecordsRequestError && (error.status === 403 || error.status === 401);
}

function displayDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function KindMark({ kind }: { kind: RecordKind }) {
  const Icon = kind === "episode" ? ScrollText : BookOpen;
  return (
    <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${kind === "episode" ? "bg-[#e9e6d8] text-[#66705c]" : "bg-[#f1e4dc] text-[#a26750]"}`}>
      <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
    </span>
  );
}

function RecordSkeleton() {
  return (
    <div className="space-y-5" aria-label="Loading record">
      <Skeleton className="h-4 w-28 bg-[#e7e4d9]" />
      <Skeleton className="h-10 w-4/5 bg-[#e7e4d9]" />
      <Skeleton className="h-4 w-2/5 bg-[#e7e4d9]" />
      <div className="mt-12 space-y-3">
        <Skeleton className="h-4 w-full bg-[#e7e4d9]" />
        <Skeleton className="h-4 w-11/12 bg-[#e7e4d9]" />
        <Skeleton className="h-4 w-4/5 bg-[#e7e4d9]" />
        <Skeleton className="h-4 w-full bg-[#e7e4d9]" />
      </div>
    </div>
  );
}

export default function CentralRecords({ params }: { params?: { id?: string } }) {
  const [location, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const pathId = location.match(/^\/admin\/records\/([^/?#]+)/)?.[1];
  const routeId = params?.id ?? pathId;
  let selectedId = routeId;
  if (routeId && !params?.id) {
    try {
      selectedId = decodeURIComponent(routeId);
    } catch {
      selectedId = routeId;
    }
  }
  const [downloadState, setDownloadState] = useState<{ id: string; kind: "stale" | "error" | "denied" } | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const pages = useInfiniteQuery({
    queryKey: CATALOG_KEY,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => fetchCatalog(pageParam, signal),
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    gcTime: 0,
    retry: false,
  });
  const records = useMemo(
    () => pages.data?.pages.flatMap((page) => page.records) ?? [],
    [pages.data],
  );
  const detailKey = ["/api/admin/central-records/detail", selectedId] as const;
  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => fetchRecord(selectedId as string, signal),
    enabled: Boolean(selectedId),
    retry: false,
    gcTime: 0,
  });
  const selectedRecord = detail.data;

  useEffect(() => {
    setDownloadState(null);
    downloadController.current?.abort();
    downloadController.current = null;
  }, [selectedId]);

  useEffect(() => () => {
    downloadController.current?.abort();
  }, []);

  const handleDownload = async () => {
    if (!selectedRecord || !selectedId) return;
    const controller = new AbortController();
    downloadController.current?.abort();
    downloadController.current = controller;
    setDownloadState(null);
    try {
      const response = await fetch(
        `/api/admin/central-records/${encodeURIComponent(selectedId)}/markdown?sha256=${encodeURIComponent(selectedRecord.sha256)}`,
        { credentials: "include", signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (response.status === 409) {
        setDownloadState({ id: selectedId, kind: "stale" });
        await queryClient.invalidateQueries({ queryKey: detailKey });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setDownloadState({ id: selectedId, kind: "denied" });
        return;
      }
      if (!response.ok) throw requestError(response.status, await response.text().catch(() => ""));
      const markdown = await response.blob();
      if (controller.signal.aborted) return;
      const href = URL.createObjectURL(markdown);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = selectedRecord.filename || `${selectedRecord.id}.md`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch (error) {
      if (!controller.signal.aborted) {
        setDownloadState({ id: selectedId, kind: isDenied(error) ? "denied" : "error" });
      }
    }
  };

  const activeDownloadState = downloadState && downloadState.id === selectedId ? downloadState.kind : null;
  const catalogErrorDenied = isDenied(pages.error);
  const detailErrorDenied = isDenied(detail.error);
  const currentRecordInCatalog = records.find((record) => record.id === selectedId);

  return (
    <div className="min-h-[100dvh] bg-[#f3f1e9] text-[#292d29]">
      <div className="mx-auto max-w-[1500px] px-4 pb-12 pt-5 sm:px-7 lg:px-10">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-[#d9d6ca] pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#c9c8b9] bg-[#e9e7dc] text-[#4f6358]">
              <Fingerprint className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.23em] text-[#77796e]">HolaHola · private archive</p>
              <p className="font-serif text-[17px] leading-tight text-[#313830]">Central records room</p>
            </div>
          </div>
          <nav className="flex items-center gap-2" aria-label="Record navigation">
            {selectedId && (
              <Button variant="ghost" size="sm" className="text-[#5d665d] hover:bg-[#e8e5da]" onClick={() => setLocation("/admin/records")}>
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                Catalog
              </Button>
            )}
            <Button asChild variant="outline" size="sm" className="border-[#d0cfc3] bg-[#f8f7f1] text-[#545d54] hover:bg-[#e9e7dc]">
              <Link href="/admin">
                <Home className="mr-2 h-4 w-4" aria-hidden="true" />
                Command center
              </Link>
            </Button>
          </nav>
        </header>

        <div className="mb-8 grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div>
            <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8a715c]">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Founder access · read only
            </p>
            <h1 className="font-serif text-[clamp(2rem,4.2vw,3.4rem)] leading-[1.02] tracking-[-0.035em] text-[#2b342e]">
              Stories, kept intact.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#72766d]">
              A quiet index of the episodes and stories at the heart of HolaHola. Each document is shown exactly as stored.
            </p>
          </div>
          <div className="flex items-center gap-3 rounded-2xl border border-[#dcd9cd] bg-[#ebe9df] px-4 py-3">
            <span className="font-serif text-3xl leading-none text-[#66715e]">{pages.isLoading ? "—" : records.length}</span>
            <span className="max-w-24 text-[10px] font-semibold uppercase leading-4 tracking-[0.15em] text-[#797c70]">
              records in view
            </span>
          </div>
        </div>

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(280px,350px)_minmax(0,1fr)]">
          <aside aria-label="Central records catalog" className="overflow-hidden rounded-[22px] border border-[#d9d7cb] bg-[#eceae0]">
            <div className="flex items-center justify-between border-b border-[#d9d7cb] px-5 py-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#88887b]">The index</p>
                <h2 className="mt-1 font-serif text-xl text-[#343b34]">All records</h2>
              </div>
              <Badge variant="outline" className="border-[#d0cec1] bg-[#f5f3eb] text-[10px] font-medium text-[#73766b]">
                {records.length}{pages.hasNextPage ? "+" : ""}
              </Badge>
            </div>

            <div className="max-h-[min(70vh,800px)] overflow-y-auto p-2">
              {pages.isLoading ? (
                <div className="space-y-2 p-2" aria-label="Loading records">
                  {[0, 1, 2, 3].map((item) => (
                    <div key={item} className="flex gap-3 rounded-xl border border-[#dfddd2] bg-[#f3f1e9] p-3">
                      <Skeleton className="h-10 w-10 shrink-0 rounded-xl bg-[#e2dfd3]" />
                      <div className="flex-1 space-y-2 pt-1">
                        <Skeleton className="h-4 w-4/5 bg-[#e2dfd3]" />
                        <Skeleton className="h-3 w-2/5 bg-[#e2dfd3]" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : pages.error ? (
                <div className="m-2 rounded-xl border border-[#ddc5b7] bg-[#f6ebe4] p-4" role="alert">
                  <div className="flex items-start gap-3">
                    {catalogErrorDenied ? <LockKeyhole className="mt-0.5 h-4 w-4 text-[#a26750]" /> : <CircleAlert className="mt-0.5 h-4 w-4 text-[#a26750]" />}
                    <div>
                      <p className="text-sm font-semibold text-[#60483d]">{catalogErrorDenied ? "Access is restricted" : "The catalog did not load"}</p>
                      <p className="mt-1 text-xs leading-5 text-[#82685c]">
                        {catalogErrorDenied ? "This private archive is available to the founder account only." : "The archive could not be reached. Try again when the connection is available."}
                      </p>
                    </div>
                  </div>
                  {!catalogErrorDenied && (
                    <Button size="sm" variant="outline" className="mt-3 border-[#d6bcae] bg-[#f8f0eb] text-[#705548]" onClick={() => pages.refetch()}>
                      <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
                    </Button>
                  )}
                </div>
              ) : records.length === 0 ? (
                <div className="m-2 rounded-xl border border-dashed border-[#d0cfc2] px-5 py-9 text-center">
                  <FileText className="mx-auto h-6 w-6 text-[#9b9a8e]" aria-hidden="true" />
                  <p className="mt-3 font-serif text-lg text-[#4c554d]">No records yet</p>
                  <p className="mt-1 text-xs leading-5 text-[#85867a]">The index will appear here when records are available.</p>
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {records.map((record, index) => {
                    const isSelected = record.id === selectedId;
                    return (
                      <li key={record.id}>
                        <button
                          type="button"
                          onClick={() => setLocation(`/admin/records/${encodeURIComponent(record.id)}`)}
                          aria-current={isSelected ? "page" : undefined}
                          className={`group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors duration-150 ${
                            isSelected
                              ? "border-[#a6ad98] bg-[#e1e4d8] shadow-[inset_3px_0_0_#657461]"
                              : "border-transparent bg-transparent hover:border-[#dfddd2] hover:bg-[#f3f1e9]"
                          }`}
                        >
                          <KindMark kind={record.kind} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium text-[13px] leading-5 text-[#394139]">{record.title || record.filename}</span>
                            <span className="mt-1 flex items-center gap-2 text-[10px] text-[#88897e]">
                              <span className="uppercase tracking-[0.12em]">{record.kind}</span>
                              {record.episodeNumber !== null && <span>· Episode {record.episodeNumber}</span>}
                              <span className="ml-auto tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                            </span>
                          </span>
                          <ArrowUpRight className={`h-3.5 w-3.5 shrink-0 text-[#8a8f83] transition-opacity ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {pages.hasNextPage && !pages.error && (
              <div className="border-t border-[#d9d7cb] p-3">
                <Button
                  variant="ghost"
                  className="w-full text-xs text-[#687266] hover:bg-[#e3e2d8]"
                  onClick={() => pages.fetchNextPage()}
                  disabled={pages.isFetchingNextPage}
                >
                  {pages.isFetchingNextPage ? "Loading more records…" : "Show more records"}
                  <ChevronDown className="ml-2 h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            )}
          </aside>

          <main aria-live="polite" className="min-h-[520px]">
            {!selectedId ? (
              <Card className="relative flex min-h-[520px] overflow-hidden rounded-[22px] border-[#dedbcf] bg-[#f8f7f1] shadow-none">
                <div className="absolute right-[-70px] top-[-75px] h-64 w-64 rounded-full border border-[#e4e1d6]" />
                <div className="absolute right-[-28px] top-[-32px] h-44 w-44 rounded-full border border-[#e4e1d6]" />
                <div className="relative flex flex-1 flex-col justify-between p-7 sm:p-10">
                  <div className="max-w-xl">
                    <Badge variant="outline" className="border-[#d9d5c6] bg-[#efede3] text-[10px] font-semibold uppercase tracking-[0.15em] text-[#797b6d]">
                      Archive reader
                    </Badge>
                    <h2 className="mt-8 max-w-lg font-serif text-4xl leading-[1.05] tracking-[-0.03em] text-[#394238] sm:text-5xl">
                      A record is more than its title.
                    </h2>
                    <p className="mt-5 max-w-md text-sm leading-7 text-[#7a7c72]">
                      Select an episode or story to read its original text, inspect its provenance, and download the exact stored Markdown.
                    </p>
                  </div>
                  <div className="mt-14 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.15em] text-[#87877b]">
                    <span className="h-px w-10 bg-[#c8c7b9]" />
                    Choose a record from the index
                  </div>
                </div>
              </Card>
            ) : detail.isLoading ? (
              <Card className="min-h-[520px] rounded-[22px] border-[#dedbcf] bg-[#f8f7f1] p-7 shadow-none sm:p-10">
                <RecordSkeleton />
              </Card>
            ) : detail.error ? (
              <Card className="flex min-h-[520px] items-center justify-center rounded-[22px] border-[#dedbcf] bg-[#f8f7f1] p-7 shadow-none">
                <div className="max-w-md text-center">
                  <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#eee6dc] text-[#9b6850]">
                    {detailErrorDenied ? <LockKeyhole className="h-5 w-5" /> : <CircleAlert className="h-5 w-5" />}
                  </span>
                  <h2 className="mt-4 font-serif text-2xl text-[#41473f]">{detailErrorDenied ? "This record is private" : "Record unavailable"}</h2>
                  <p className="mt-2 text-sm leading-6 text-[#7b7d73]">
                    {detailErrorDenied ? "The authenticated API did not grant access to this archive." : "This record could not be loaded. It may have moved, or the connection may have been interrupted."}
                  </p>
                  {!detailErrorDenied && (
                    <Button variant="outline" className="mt-5 border-[#d4d2c5] bg-[#f1efe6]" onClick={() => detail.refetch()}>
                      <RefreshCw className="mr-2 h-4 w-4" /> Try again
                    </Button>
                  )}
                  <Button variant="ghost" className="mt-5 text-[#697267]" onClick={() => setLocation("/admin/records")}>Back to the catalog</Button>
                </div>
              </Card>
            ) : selectedRecord ? (
              <article className="overflow-hidden rounded-[22px] border border-[#dedbcf] bg-[#f8f7f1] shadow-none">
                <div className="border-b border-[#e2dfd4] px-6 py-6 sm:px-10 sm:py-8">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8a715c]">
                      <span className="h-1.5 w-1.5 rounded-full bg-[#a2765e]" />
                      {selectedRecord.kind === "episode" ? "Episode record" : "Story record"}
                      {selectedRecord.episodeNumber !== null && <span className="text-[#a3a093]">/ {selectedRecord.episodeNumber}</span>}
                    </div>
                    <Button onClick={handleDownload} className="h-9 rounded-full bg-[#536759] px-4 text-xs text-[#fbfaf4] hover:bg-[#43574a]">
                      <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                      Download exact Markdown
                    </Button>
                  </div>
                  <h2 className="mt-6 max-w-4xl break-words font-serif text-[clamp(2rem,4vw,3.25rem)] leading-[1.04] tracking-[-0.035em] text-[#303a32]">
                    {selectedRecord.title || selectedRecord.filename}
                  </h2>
                  <p className="mt-3 break-all font-mono text-[11px] text-[#99978b]">{selectedRecord.filename}</p>
                  {activeDownloadState && (
                    <div role="status" className={`mt-5 rounded-xl border px-4 py-3 text-xs leading-5 ${activeDownloadState === "stale" ? "border-[#dfcba4] bg-[#f5efdf] text-[#785f32]" : "border-[#ddc5b7] bg-[#f6ebe4] text-[#795a4b]"}`}>
                      {activeDownloadState === "stale" && "This stored document changed since it was read. The record has been refreshed; download again for the current exact version."}
                      {activeDownloadState === "denied" && "The archive did not authorize this download. Founder access is required."}
                      {activeDownloadState === "error" && "The download could not be completed. Please try again."}
                    </div>
                  )}
                </div>

                <div className="grid gap-0 border-b border-[#e2dfd4] sm:grid-cols-2 xl:grid-cols-4">
                  <div className="flex gap-3 border-b border-[#e2dfd4] px-6 py-4 sm:border-r sm:px-7 xl:border-b-0">
                    <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-[#8d917e]" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#969589]">Recorded</p>
                      <p className="mt-1 text-xs text-[#565f56]">{displayDate(selectedRecord.recordedAt)}</p>
                    </div>
                  </div>
                  <div className="flex gap-3 border-b border-[#e2dfd4] px-6 py-4 sm:border-r xl:border-b-0">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[#8d917e]" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#969589]">Stored size</p>
                      <p className="mt-1 text-xs tabular-nums text-[#565f56]">{formatBytes(selectedRecord.bytes)}</p>
                    </div>
                  </div>
                  <div className="flex gap-3 border-b border-[#e2dfd4] px-6 py-4 sm:border-r sm:border-b-0">
                    <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-[#8d917e]" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#969589]">Record ID</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-[#565f56]">{selectedRecord.id}</p>
                    </div>
                  </div>
                  <div className="flex gap-3 px-6 py-4">
                    <Fingerprint className="mt-0.5 h-4 w-4 shrink-0 text-[#8d917e]" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#969589]">Parent record</p>
                      <p className="mt-1 break-all font-mono text-[10px] text-[#565f56]">{selectedRecord.parentId || "None"}</p>
                    </div>
                  </div>
                </div>

                <div className="px-6 py-6 sm:px-10 sm:py-9">
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <h3 className="font-serif text-xl text-[#414a41]">Original text</h3>
                    <span className="rounded-full border border-[#e0ddd1] bg-[#f1efe6] px-3 py-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-[#8a897d]">Plain text · unmodified</span>
                  </div>
                  <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-[#e4e1d6] bg-[#f2f0e8] px-5 py-6 font-mono text-[12px] leading-[1.9] text-[#50594f] sm:px-7 sm:py-8 sm:text-[13px]">{selectedRecord.content}</pre>
                </div>

                <footer className="border-t border-[#e2dfd4] bg-[#f1efe6] px-6 py-5 sm:px-10">
                  <div className="flex items-start gap-3">
                    <Fingerprint className="mt-0.5 h-4 w-4 shrink-0 text-[#78816f]" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.17em] text-[#848578]">Read digest · SHA-256</p>
                      <p className="mt-1 break-all font-mono text-[10px] leading-5 text-[#686e63] sm:text-[11px]">{selectedRecord.sha256}</p>
                    </div>
                  </div>
                  {currentRecordInCatalog && currentRecordInCatalog.recordedAt !== selectedRecord.recordedAt && (
                    <p className="mt-3 text-xs text-[#8a715c]">Catalog metadata changed since this document was opened.</p>
                  )}
                </footer>
              </article>
            ) : null}
          </main>
        </div>

        <footer className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-[#d9d6ca] pt-4 text-[10px] uppercase tracking-[0.14em] text-[#939387]">
          <span>Private source archive</span>
          <span>Read-only · content is never stored in browser persistence</span>
        </footer>
      </div>
    </div>
  );
}
