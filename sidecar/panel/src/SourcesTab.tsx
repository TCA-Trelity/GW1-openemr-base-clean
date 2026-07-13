// Sources tab (S2.12 elevation) — document list with provenance badges (type, date,
// received method, filename, OCR quality) + full-text panel with cited-span highlighting
// (port of SourcesView.jsx: char-range first, excerpt-text fallback).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileText, Inbox, MapPin, ScanText, X } from 'lucide-react';
import type { IngestionRecordView } from './api';
import DocumentOverlay, { citationsForDocument } from './DocumentOverlay';
import type { SourceDocumentRecord } from './types';
import { Card, formatDate, sourceTypeConfig, titleCase } from './ui';
import UploadCard from './UploadCard';

export interface SourceFocus {
    documentId: string | null;
    start: number | null;
    end: number | null;
    excerpt: string | null;
}

function docId(doc: SourceDocumentRecord): string {
    return doc.id ?? doc.document_id ?? '';
}

/** The store carries filename/received_* in extras; legacy top-level spellings still win a fallback. */
function docFilename(doc: SourceDocumentRecord): string | undefined {
    return doc.extras?.filename ?? doc.filename;
}

function docReceivedMethod(doc: SourceDocumentRecord): string | undefined {
    return doc.extras?.received_method ?? doc.received_method;
}

function docTitle(doc: SourceDocumentRecord): string {
    return doc.metadata?.original_filename ?? docFilename(doc) ?? docId(doc);
}

/** Provenance badges: how the document arrived + OCR confidence when the content carries one. */
function ProvenanceBadges({ doc }: { doc: SourceDocumentRecord }) {
    const method = docReceivedMethod(doc);
    const ocr = doc.content.ocr_quality;
    if (method === undefined && ocr === undefined) {
        return null;
    }
    return (
        <span className="flex flex-wrap items-center gap-1 mt-1">
            {method !== undefined && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium bg-slate-50 text-slate-600 border-slate-200">
                    <Inbox className="w-3 h-3" />
                    {titleCase(method)}
                </span>
            )}
            {ocr !== undefined && (
                <span
                    title={`OCR confidence ${String(ocr)}`}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${
                        ocr < 0.9 ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    }`}
                >
                    <ScanText className="w-3 h-3" />
                    OCR {Math.round(ocr * 100)}%
                </span>
            )}
        </span>
    );
}

function docText(doc: SourceDocumentRecord): string {
    if (doc.content.text_content !== undefined && doc.content.text_content !== '') {
        return doc.content.text_content;
    }
    if (doc.content.structured_content !== undefined) {
        return JSON.stringify(doc.content.structured_content, null, 2);
    }
    return '(no text content available for this document)';
}

/** Highlight the cited span: trust the character range when it matches the excerpt, else find the excerpt. */
function renderHighlighted(text: string, focus: SourceFocus | null): ReactNode {
    if (focus === null) {
        return text;
    }
    let start = -1;
    let end = -1;
    if (focus.start !== null && focus.end !== null && focus.start >= 0 && focus.end <= text.length && focus.start < focus.end) {
        const slice = text.slice(focus.start, focus.end);
        if (focus.excerpt === null || slice === focus.excerpt) {
            start = focus.start;
            end = focus.end;
        }
    }
    if (start < 0 && focus.excerpt !== null && focus.excerpt !== '') {
        const index = text.indexOf(focus.excerpt);
        if (index >= 0) {
            start = index;
            end = index + focus.excerpt.length;
        }
    }
    if (start < 0) {
        return text;
    }
    return (
        <>
            {text.slice(0, start)}
            <mark id="citation-highlight" className="bg-amber-200 text-amber-900 px-0.5 rounded scroll-mt-20">
                {text.slice(start, end)}
            </mark>
            {text.slice(end)}
        </>
    );
}

export default function SourcesTab({
    documents,
    focus,
    onClearFocus,
    patientId,
    facts,
    onIngested,
}: {
    documents: SourceDocumentRecord[];
    focus: SourceFocus | null;
    onClearFocus: () => void;
    /** Week 2 E.1/E.2 — when present, the tab offers upload + the citation bbox overlay. */
    patientId?: string;
    facts?: unknown[];
    onIngested?: () => void;
}) {
    const [preview, setPreview] = useState<IngestionRecordView | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // Q1: closing the viewer must stick — without this flag the auto-select below would
    // instantly reopen the document the user just dismissed.
    const [dismissed, setDismissed] = useState(false);
    // Q2: one type chip at a time; null = all documents.
    const [typeFilter, setTypeFilter] = useState<string | null>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    // A citation deep-link opens its document (and clears any filter hiding it); unknown ids
    // fall through to the notice below.
    useEffect(() => {
        if (focus?.documentId != null && documents.some((doc) => docId(doc) === focus.documentId)) {
            setSelectedId(focus.documentId);
            setTypeFilter(null);
        }
    }, [focus, documents]);

    // Q1: the viewer never opens empty — land on the first document in the rail. A pending
    // citation deep-link wins: both effects flush in the same pass with the same stale null,
    // so without this guard the auto-select would stomp the focus target (last write wins).
    useEffect(() => {
        if (!dismissed && selectedId === null && documents.length > 0 && focus?.documentId == null) {
            setSelectedId(docId(documents[0]!));
        }
    }, [dismissed, selectedId, documents, focus]);

    // Patient switch: the old selection is not in the new document set — start fresh.
    useEffect(() => {
        if (selectedId !== null && !documents.some((doc) => docId(doc) === selectedId)) {
            setSelectedId(null);
            setDismissed(false);
            setTypeFilter(null);
        }
    }, [documents, selectedId]);

    // Scroll the highlight into view once the full text is on screen.
    useEffect(() => {
        const mark = contentRef.current?.querySelector('#citation-highlight');
        if (mark !== null && mark !== undefined && typeof mark.scrollIntoView === 'function') {
            mark.scrollIntoView({ block: 'center' });
        }
    }, [selectedId, focus]);

    const selected = useMemo(
        () => documents.find((doc) => docId(doc) === selectedId) ?? null,
        [documents, selectedId],
    );
    const focusMissing = focus?.documentId != null && !documents.some((doc) => docId(doc) === focus.documentId);

    // Q2: filter chips by document type, labeled via the same config as the type badges.
    const typeCounts = useMemo(() => {
        const counts = new Map<string, number>();
        for (const doc of documents) {
            counts.set(doc.document_type, (counts.get(doc.document_type) ?? 0) + 1);
        }
        return [...counts.entries()];
    }, [documents]);
    const visibleDocuments = typeFilter === null ? documents : documents.filter((doc) => doc.document_type === typeFilter);

    // E.1/E.2: upload + overlay ride the tab whenever a patient context exists.
    const uploadSection =
        patientId === undefined ? null : (
            <UploadCard
                patientId={patientId}
                onIngested={() => onIngested?.()}
                onPreview={(record) => setPreview(record)}
            />
        );
    const overlay =
        preview === null ? null : (
            <DocumentOverlay
                ingestionId={preview.id}
                filename={preview.filename}
                citations={citationsForDocument(facts ?? [], preview.source_document_id)}
                onClose={() => setPreview(null)}
            />
        );

    if (documents.length === 0) {
        return (
            <div className="space-y-4">
                {uploadSection}
                {overlay}
                <div className="text-center py-12 text-slate-500">
                    <FileText className="w-12 h-12 mx-auto mb-4 text-slate-300" />
                    <p>No source documents available for this patient.</p>
                    {focusMissing && <p className="text-sm mt-2 text-amber-600">The cited document could not be loaded from the fact bundle.</p>}
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {uploadSection}
            {overlay}
            <div className="flex items-center justify-between pb-4 border-b border-slate-200">
                <div>
                    <h2 className="text-lg font-semibold text-slate-800">Data Sources</h2>
                    <p className="text-sm text-slate-500 mt-1">All source documents that informed this patient briefing</p>
                </div>
                <span className="inline-flex px-2.5 py-1 rounded-md border border-slate-200 text-xs font-medium text-slate-600">
                    {documents.length} Documents
                </span>
            </div>

            {focusMissing && (
                <p className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
                    The cited document ({focus?.documentId}) is not in the fact bundle.
                </p>
            )}

            {/* Q2: type filter — 13 documents is a real list to navigate. */}
            {typeCounts.length > 1 && (
                <div role="group" aria-label="Filter documents by type" className="flex flex-wrap items-center gap-1.5">
                    <button
                        type="button"
                        aria-pressed={typeFilter === null}
                        onClick={() => setTypeFilter(null)}
                        className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
                            typeFilter === null ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                        }`}
                    >
                        All ({documents.length})
                    </button>
                    {typeCounts.map(([type, count]) => (
                        <button
                            key={type}
                            type="button"
                            aria-pressed={typeFilter === type}
                            onClick={() => setTypeFilter(typeFilter === type ? null : type)}
                            className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
                                typeFilter === type ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                            }`}
                        >
                            {sourceTypeConfig(type).label} ({count})
                        </button>
                    ))}
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-[280px,1fr] items-start">
                {/* Document list */}
                <div className="space-y-2">
                    {visibleDocuments.length === 0 && (
                        <p className="text-sm text-slate-400 p-3">No documents of this type.</p>
                    )}
                    {visibleDocuments.map((doc) => {
                        const config = sourceTypeConfig(doc.document_type);
                        const Icon = config.icon;
                        const id = docId(doc);
                        const isSelected = id === selectedId;
                        return (
                            <button
                                key={id}
                                type="button"
                                onClick={() => setSelectedId(id)}
                                className={`w-full text-left bg-white rounded-xl border p-3 transition-all hover:border-slate-300 hover:shadow-sm ${
                                    isSelected ? 'border-blue-300 ring-1 ring-blue-200' : 'border-slate-200'
                                }`}
                            >
                                <div className="flex items-start gap-3">
                                    <span className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 border ${config.color}`}>
                                        <Icon className="w-4 h-4" />
                                    </span>
                                    <span className="min-w-0">
                                        <span className={`inline-flex px-1.5 py-0.5 rounded-md border text-[10px] font-medium ${config.color}`}>
                                            {config.label}
                                        </span>
                                        <span className="block text-sm font-medium text-slate-700 truncate mt-1">{docTitle(doc)}</span>
                                        {docFilename(doc) !== undefined && docFilename(doc) !== docTitle(doc) && (
                                            <span className="block text-[10px] text-slate-400 truncate mt-0.5">{docFilename(doc)}</span>
                                        )}
                                        <span className="block text-xs text-slate-400 mt-0.5">{formatDate(doc.document_date)}</span>
                                        <ProvenanceBadges doc={doc} />
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>

                {/* Full-text panel */}
                {selected !== null ? (
                    <Card className="overflow-hidden">
                        <div className="p-4 border-b border-slate-200 flex items-start justify-between gap-3">
                            <div>
                                <h3 className="font-semibold text-slate-800">{docTitle(selected)}</h3>
                                <p className="text-xs text-slate-400 mt-0.5">
                                    {sourceTypeConfig(selected.document_type).label} · {formatDate(selected.document_date)}
                                    {docReceivedMethod(selected) !== undefined && ` · via ${docReceivedMethod(selected)}`}
                                    {selected.extras?.received_date !== undefined &&
                                        ` · received ${formatDate(selected.extras.received_date)}`}
                                    {selected.content.ocr_quality !== undefined &&
                                        ` · OCR ${Math.round(selected.content.ocr_quality * 100)}%`}
                                </p>
                            </div>
                            <button
                                type="button"
                                aria-label="Close document"
                                onClick={() => {
                                    setSelectedId(null);
                                    setDismissed(true); // Q1: dismissal sticks; auto-select must not reopen it
                                }}
                                className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-100"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        {focus !== null && selectedId === focus.documentId && (
                            <div className="mx-4 mt-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2">
                                <MapPin className="w-4 h-4 text-amber-600 flex-shrink-0" />
                                <span className="text-sm text-amber-800">
                                    Showing citation location.
                                    <button type="button" onClick={onClearFocus} className="ml-2 text-amber-600 hover:text-amber-700 underline">
                                        Clear highlight
                                    </button>
                                </span>
                            </div>
                        )}
                        <div
                            ref={contentRef}
                            className={`p-4 max-h-[32rem] overflow-y-auto whitespace-pre-wrap text-sm text-slate-600 leading-relaxed ${
                                selected.content.format === 'structured' ? 'font-mono text-xs bg-slate-50' : ''
                            }`}
                        >
                            {renderHighlighted(docText(selected), selectedId === focus?.documentId ? focus : null)}
                        </div>
                    </Card>
                ) : (
                    <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                        <FileText className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                        <p className="text-sm">Select a document to view its full text</p>
                    </div>
                )}
            </div>
        </div>
    );
}
