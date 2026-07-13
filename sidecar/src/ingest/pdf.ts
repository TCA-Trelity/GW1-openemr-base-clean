// PDF word-geometry extraction (Wave A.5 input, REQ R5). Reads the PDF's own text layer
// via pdfjs-dist and emits normalized word boxes ([0,1], top-left origin) — the
// deterministic geometry the grounding pass matches extracted quotes against.
//
// Image-only scans (our degraded fixtures, real faxes) have NO text layer: this returns
// pages with zero words, so grounding lands on the honest lower rungs of the ladder
// (page-level or unverified) instead of fabricating boxes. An OCR provider (tesseract)
// can slot in behind the same PdfWords shape later without touching grounding.
export interface PdfWord {
    text: string;
    /** Normalized page coords, top-left origin. */
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface PdfPageWords {
    /** 1-based page number (citation pages are 1-based everywhere). */
    page: number;
    width: number;
    height: number;
    words: PdfWord[];
    /** Concatenated text-layer content for contains-checks and gate verification. */
    text: string;
}

export interface PdfWords {
    pages: PdfPageWords[];
    /** All pages' text joined — stored as the source document's text content. */
    fullText: string;
}

interface PdfjsTextItem {
    str?: string;
    transform?: number[];
    width?: number;
    height?: number;
}

export async function extractPdfWords(bytes: Uint8Array): Promise<PdfWords> {
    // Dynamic import keeps pdfjs out of every process that never ingests a PDF.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const document = await pdfjs.getDocument({
        data: new Uint8Array(bytes), // pdfjs transfers the buffer; hand it a private copy
        useWorkerFetch: false,
        disableFontFace: true,
    }).promise;

    const pages: PdfPageWords[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const words: PdfWord[] = [];
        const lineParts: string[] = [];

        for (const raw of content.items as PdfjsTextItem[]) {
            const str = raw.str ?? '';
            if (str.trim() === '' || raw.transform === undefined) {
                continue;
            }
            lineParts.push(str);
            const itemX = raw.transform[4] ?? 0;
            const itemY = raw.transform[5] ?? 0; // baseline, bottom-left origin
            const itemWidth = raw.width ?? 0;
            const itemHeight = raw.height ?? Math.abs(raw.transform[3] ?? 10);
            // Split the item into words, apportioning width by character count — an
            // approximation, but word-granular boxes are overlay hints, not survey data.
            const charWidth = str.length > 0 ? itemWidth / str.length : 0;
            let cursor = 0;
            for (const match of str.matchAll(/\S+/g)) {
                const start = match.index ?? cursor;
                const word = match[0];
                words.push({
                    text: word,
                    x: clamp01((itemX + start * charWidth) / viewport.width),
                    y: clamp01((viewport.height - itemY - itemHeight) / viewport.height),
                    w: clamp01((word.length * charWidth) / viewport.width),
                    h: clamp01((itemHeight * 1.25) / viewport.height),
                });
                cursor = start + word.length;
            }
        }
        pages.push({
            page: pageNumber,
            width: viewport.width,
            height: viewport.height,
            words,
            text: lineParts.join(' ').replace(/\s+/g, ' ').trim(),
        });
    }
    await document.cleanup();
    return { pages, fullText: pages.map((page) => page.text).join('\n\n') };
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}
