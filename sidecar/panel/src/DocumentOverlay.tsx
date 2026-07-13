// E.2 (REQ R5 — required core): PDF preview with the citation bbox overlay. The three
// grounding outcomes are VISIBLY distinct, mirroring the deterministic ladder (P2):
//   word_box    — tight amber rectangle drawn from the normalized bbox (citable)
//   page        — dashed page-frame highlight, "located on this page" (citable)
//   unverified  — red flag in the legend, NO geometry ever drawn (never citable)
// The PDF renders via pdfjs from the sidecar's preview-cache route; overlay geometry is
// pure math over the normalized [0,1] coordinates (overlayRectStyle — unit-tested).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, FileWarning, MapPin, ScanSearch, X } from 'lucide-react';
import { ingestionFileUrl } from './api';
import type { CitationRef } from './types';

/** Normalized [0,1] page-bbox → absolute overlay style for a rendered page size. */
export function overlayRectStyle(
    bbox: { x: number; y: number; w: number; h: number },
    renderedWidth: number,
    renderedHeight: number,
): CSSProperties {
    return {
        left: `${(bbox.x * renderedWidth).toFixed(1)}px`,
        top: `${(bbox.y * renderedHeight).toFixed(1)}px`,
        width: `${(Math.max(bbox.w, 0.004) * renderedWidth).toFixed(1)}px`,
        height: `${(Math.max(bbox.h, 0.004) * renderedHeight).toFixed(1)}px`,
    };
}

export interface OverlayCitation {
    factId: string;
    factLabel: string;
    citation: CitationRef;
}

/** The structural slice of a fact the overlay reads — the bundle serves `unknown[]`. */
interface OverlayFactLike {
    id: string;
    fact_type: string;
    content: Record<string, unknown>;
    source_document_id?: string | null;
    sources?: CitationRef[];
}

function isOverlayFact(value: unknown): value is OverlayFactLike {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const fact = value as Record<string, unknown>;
    return typeof fact['id'] === 'string' && typeof fact['fact_type'] === 'string' && typeof fact['content'] === 'object' && fact['content'] !== null;
}

/** Facts → overlay entries for one source document (the just-ingested one). */
export function citationsForDocument(facts: unknown[], sourceDocumentId: string | null): OverlayCitation[] {
    if (sourceDocumentId === null) {
        return [];
    }
    return facts
        .filter(isOverlayFact)
        .filter((fact) => fact.source_document_id === sourceDocumentId)
        .flatMap((fact) =>
            (fact.sources ?? []).map((citation) => ({
                factId: fact.id,
                factLabel: factLabel(fact),
                citation,
            })),
        );
}

function factLabel(fact: OverlayFactLike): string {
    const content = fact.content;
    const name = content['test_name'] ?? content['name'] ?? content['substance'] ?? content['condition'] ?? content['goal'] ?? content['statement'];
    const value = content['value'];
    const base = typeof name === 'string' ? name : fact.fact_type.replace('_', ' ');
    return typeof value === 'string' ? `${base} ${value}` : base;
}

interface PageRenderState {
    kind: 'loading' | 'ready' | 'error';
    width: number;
    height: number;
    message?: string;
}

export interface DocumentOverlayProps {
    ingestionId: string;
    filename: string;
    citations: OverlayCitation[];
    onClose: () => void;
}

export default function DocumentOverlay({ ingestionId, filename, citations, onClose }: DocumentOverlayProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [render, setRender] = useState<PageRenderState>({ kind: 'loading', width: 0, height: 0 });
    const [focusedId, setFocusedId] = useState<string | null>(null);

    const boxed = citations.filter((entry) => entry.citation.excerpt_location?.type === 'page_bbox');
    const pageOnly = citations.filter((entry) => entry.citation.excerpt_location?.type === 'page');
    const unverified = citations.filter((entry) => entry.citation.excerpt_location === null);

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                // Dynamic import keeps pdfjs out of the main bundle until a preview opens.
                const pdfjs = await import('pdfjs-dist');
                const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
                pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
                const doc = await pdfjs.getDocument({ url: ingestionFileUrl(ingestionId) }).promise;
                const page = await doc.getPage(1);
                const viewport = page.getViewport({ scale: 1.35 });
                const canvas = canvasRef.current;
                if (canvas === null || cancelled) {
                    return;
                }
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                const context = canvas.getContext('2d');
                if (context === null) {
                    throw new Error('canvas 2d context unavailable');
                }
                await page.render({ canvas, canvasContext: context, viewport }).promise;
                if (!cancelled) {
                    setRender({ kind: 'ready', width: viewport.width, height: viewport.height });
                }
            } catch (error) {
                if (!cancelled) {
                    setRender({
                        kind: 'error',
                        width: 0,
                        height: 0,
                        message: error instanceof Error ? error.message : 'preview failed',
                    });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [ingestionId]);

    return (
        <div className="fixed inset-0 z-50 bg-slate-900/70 flex items-center justify-center p-4" role="dialog" aria-label={`Document preview: ${filename}`}>
            <div className="bg-white rounded-xl shadow-2xl max-h-[92vh] w-full max-w-5xl flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                    <div className="flex items-center gap-2 min-w-0">
                        <ScanSearch className="w-4 h-4 text-indigo-600 shrink-0" />
                        <p className="text-sm font-semibold text-slate-800 truncate">{filename}</p>
                        <span className="text-[11px] text-slate-500 shrink-0">citation overlay · page 1</span>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close preview" className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="flex flex-1 min-h-0">
                    <div className="flex-1 overflow-auto bg-slate-100 p-4">
                        {render.kind === 'error' ? (
                            <div className="h-48 flex flex-col items-center justify-center text-center gap-2 text-slate-500">
                                <FileWarning className="w-6 h-6" />
                                <p className="text-sm">PDF preview unavailable in this browser session.</p>
                                <p className="text-xs">The citation outcomes below still show each field&apos;s grounding tier.</p>
                            </div>
                        ) : (
                            <div className="relative mx-auto w-fit shadow-md" data-testid="overlay-stage">
                                <canvas ref={canvasRef} className="block bg-white" />
                                {render.kind === 'ready' && pageOnly.length > 0 && (
                                    <div
                                        className="absolute inset-0 border-4 border-dashed border-sky-400/70 pointer-events-none"
                                        title={`${pageOnly.length} value(s) located on this page without tight geometry`}
                                    />
                                )}
                                {render.kind === 'ready' &&
                                    boxed.map((entry) => {
                                        const location = entry.citation.excerpt_location;
                                        if (location?.type !== 'page_bbox') {
                                            return null;
                                        }
                                        const focused = focusedId === entry.citation.id;
                                        return (
                                            <button
                                                key={entry.citation.id}
                                                type="button"
                                                data-testid="overlay-bbox"
                                                onClick={() => setFocusedId(focused ? null : entry.citation.id)}
                                                title={`${entry.factLabel} — “${entry.citation.excerpt_text ?? ''}”`}
                                                className={`absolute border-2 rounded-sm transition-colors ${
                                                    focused ? 'border-amber-600 bg-amber-400/30' : 'border-amber-500 bg-amber-300/20 hover:bg-amber-300/35'
                                                }`}
                                                style={overlayRectStyle(location, render.width, render.height)}
                                            />
                                        );
                                    })}
                            </div>
                        )}
                    </div>
                    <aside className="w-72 shrink-0 border-l border-slate-200 overflow-y-auto p-3 space-y-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Grounding outcomes</p>
                        <section>
                            <p className="text-xs font-semibold text-amber-700 mb-1">Located — tight geometry ({boxed.length})</p>
                            <ul className="space-y-1">
                                {boxed.map((entry) => (
                                    <li key={entry.citation.id}>
                                        <button
                                            type="button"
                                            onClick={() => setFocusedId(entry.citation.id)}
                                            className={`w-full text-left text-xs rounded-md border px-2 py-1.5 ${
                                                focusedId === entry.citation.id
                                                    ? 'border-amber-500 bg-amber-50 text-amber-900'
                                                    : 'border-slate-200 hover:border-amber-300 text-slate-700'
                                            }`}
                                        >
                                            <span className="font-medium">{entry.factLabel}</span>
                                            <span className="block text-slate-500 truncate">“{entry.citation.excerpt_text ?? ''}”</span>
                                        </button>
                                    </li>
                                ))}
                                {boxed.length === 0 && <li className="text-xs text-slate-400">None on this document.</li>}
                            </ul>
                        </section>
                        <section>
                            <p className="text-xs font-semibold text-sky-700 mb-1 flex items-center gap-1">
                                <MapPin className="w-3 h-3" /> Page-level ({pageOnly.length})
                            </p>
                            <ul className="space-y-1">
                                {pageOnly.map((entry) => (
                                    <li key={entry.citation.id} className="text-xs text-slate-600 border border-slate-200 rounded-md px-2 py-1.5">
                                        <span className="font-medium">{entry.factLabel}</span>
                                        <span className="block text-slate-500">on page — no tight geometry</span>
                                    </li>
                                ))}
                                {pageOnly.length === 0 && <li className="text-xs text-slate-400">None.</li>}
                            </ul>
                        </section>
                        <section>
                            <p className="text-xs font-semibold text-red-700 mb-1 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> Not located — never citable ({unverified.length})
                            </p>
                            <ul className="space-y-1">
                                {unverified.map((entry) => (
                                    <li
                                        key={entry.citation.id}
                                        data-testid="overlay-unverified"
                                        className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-md px-2 py-1.5"
                                    >
                                        <span className="font-medium">{entry.factLabel}</span>
                                        <span className="block">quote not found in this document — excluded from citable claims</span>
                                    </li>
                                ))}
                                {unverified.length === 0 && <li className="text-xs text-slate-400">None — every extracted value was located.</li>}
                            </ul>
                        </section>
                    </aside>
                </div>
            </div>
        </div>
    );
}
