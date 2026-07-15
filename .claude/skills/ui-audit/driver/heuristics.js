/**
 * Pass A: static DOM-anomaly scan. Runs inside the page via page.evaluate().
 * Produces candidate flags only — these are priors for the vision-review
 * stage, never verdicts, and are labeled as such in the manifest.
 */
export async function scanDomAnomalies(page) {
    return page.evaluate(() => {
        const flags = [];
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        if (document.documentElement.scrollWidth > viewportWidth + 1) {
            flags.push({
                type: 'horizontal-overflow',
                detail: `document.scrollWidth ${document.documentElement.scrollWidth} exceeds viewport width ${viewportWidth}`,
            });
        }

        const interactiveSelector = 'button, a, input, select, textarea, [role="button"], [onclick]';
        const nodes = Array.from(document.querySelectorAll(interactiveSelector));
        let checked = 0;
        const CHECK_CAP = 500; // bound the scan on pathological pages

        for (const el of nodes) {
            if (checked >= CHECK_CAP) break;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
            checked += 1;

            const rect = el.getBoundingClientRect();
            const selector = describeElement(el);

            if (rect.width === 0 || rect.height === 0) {
                flags.push({ type: 'zero-size-interactive', selector, detail: `${rect.width}x${rect.height}` });
                continue;
            }

            const fullyOffscreen =
                rect.right < 0 || rect.bottom < 0 || rect.left > viewportWidth || rect.top > viewportHeight * 4;
            if (fullyOffscreen && style.position === 'fixed') {
                flags.push({ type: 'fixed-element-offscreen', selector, detail: JSON.stringify(rect) });
            }

            if (el.tagName === 'BUTTON' || el.tagName === 'A') {
                const text = (el.textContent || '').trim();
                if (text && el.scrollWidth > el.clientWidth + 2 && style.overflow !== 'visible') {
                    flags.push({ type: 'text-truncation', selector, detail: text.slice(0, 60) });
                }
            }
        }

        // Non-interactive containers (divs, list items, cells, etc.) are where
        // most "container inconsistency" bugs live — clipped/overflowing
        // content, cards that don't match a sibling card's sizing. These are
        // scanned separately from the interactive pass above since the checks
        // and cap need to be broader.
        const containerSelector = 'div, section, article, li, td, th, p, span, header, footer, aside, main';
        const containerNodes = Array.from(document.querySelectorAll(containerSelector));
        let containersChecked = 0;
        const CONTAINER_CHECK_CAP = 800;

        for (const el of containerNodes) {
            if (containersChecked >= CONTAINER_CHECK_CAP) break;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue; // not rendered, nothing to say
            containersChecked += 1;

            const clipsOverflow = style.overflow === 'hidden' || style.overflow === 'clip' || style.overflowX === 'hidden';
            if (clipsOverflow && el.scrollWidth > el.clientWidth + 2) {
                const text = (el.textContent || '').trim();
                if (text) {
                    flags.push({ type: 'container-content-clipped', selector: describeElement(el), detail: text.slice(0, 60) });
                }
            }

            // A child rendering wider than its parent's content box, without the
            // parent clipping it, shows up visually as a layout break (content
            // spilling out of its container) even though nothing is technically
            // "hidden".
            const parent = el.parentElement;
            if (parent && parent !== document.body) {
                const parentRect = parent.getBoundingClientRect();
                const parentStyle = window.getComputedStyle(parent);
                const parentClips = parentStyle.overflow === 'hidden' || parentStyle.overflow === 'clip';
                if (!parentClips && parentRect.width > 40 && rect.right > parentRect.right + 4 && rect.left >= parentRect.left - 4) {
                    flags.push({
                        type: 'container-child-overflows-parent',
                        selector: describeElement(el),
                        detail: `child right edge ${Math.round(rect.right)} exceeds parent right edge ${Math.round(parentRect.right)}`,
                    });
                }
            }
        }

        function describeElement(el) {
            if (el.id) return `#${el.id}`;
            const cls = (el.className && typeof el.className === 'string')
                ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
                : '';
            return `${el.tagName.toLowerCase()}${cls}`;
        }

        return flags;
    });
}
