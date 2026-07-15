import { isDestructive } from './destructive-filter.js';

// Deliberately excludes plain `a[href=<real-url>]` navigational links — those
// are covered cheaply by the pass C link-health check instead. This only
// targets elements that behave like buttons/controls.
const CANDIDATE_SELECTOR = [
    'button',
    '[role="button"]',
    '.btn',
    'input[type="submit"]',
    'input[type="button"]',
    '[onclick]',
    'a[href="#"]',
    'a[href^="javascript:"]',
    '[data-toggle]',
    '[aria-haspopup]',
    '[role="tab"]',
].join(', ');

/** Enumerates candidate elements and returns stable descriptors + CSS paths. */
export async function enumerateInteractiveElements(page) {
    return page.evaluate((selector) => {
        function cssPath(el) {
            const parts = [];
            let node = el;
            while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
                let index = 1;
                let sibling = node;
                while ((sibling = sibling.previousElementSibling)) {
                    if (sibling.tagName === node.tagName) index += 1;
                }
                parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
                node = node.parentElement;
            }
            return parts.join(' > ');
        }

        const nodes = Array.from(document.querySelectorAll(selector));
        return nodes
            .filter((el) => {
                const style = window.getComputedStyle(el);
                return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
            })
            .map((el) => ({
                cssPath: cssPath(el),
                tag: el.tagName.toLowerCase(),
                text: (el.textContent || '').trim().slice(0, 80),
                ariaLabel: el.getAttribute('aria-label') || '',
                name: el.getAttribute('name') || '',
                className: (el.className && typeof el.className === 'string') ? el.className : '',
                id: el.id || '',
            }));
    }, CANDIDATE_SELECTOR);
}

/**
 * Runs the bounded interaction sweep for one page. Resets to a fresh load of
 * `pageUrl` before every action so a broken mid-crawl click can't cascade
 * into the rest of the sweep — robustness over speed.
 */
export async function runInteractionSweep({ page, pageUrl, candidates, config, tracker, onAction, screenshotDir, screenshotPrefix }) {
    const results = [];
    let actionIndex = 0;

    for (const descriptor of candidates) {
        if (actionIndex >= config.maxActionsPerPage) break;

        const destructiveMatch = isDestructive(descriptor, config.destructiveKeywords);
        if (destructiveMatch) {
            results.push({
                type: 'skipped-destructive',
                descriptor,
                reason: `matched keyword "${destructiveMatch}"`,
            });
            continue;
        }

        actionIndex += 1;
        const entry = { type: 'interaction', descriptor, actionIndex, error: null, timedOut: false };

        try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: config.perElementWaitMs });
            tracker.drain(); // discard load noise, we only want post-click deltas

            const locator = page.locator(`css=${descriptor.cssPath}`).first();
            await locator.waitFor({ state: 'visible', timeout: config.perElementWaitMs });
            await locator.scrollIntoViewIfNeeded();

            const beforeUrl = page.url();
            await locator.click({ timeout: config.perElementWaitMs, trial: false });
            await page.waitForTimeout(300); // let transitions/animations settle before screenshotting
            await page.waitForLoadState('domcontentloaded', { timeout: config.perElementWaitMs }).catch(() => {});

            entry.navigationResult = page.url() !== beforeUrl ? 'navigated' : 'same-page';
            entry.consoleDelta = tracker.drain();

            const shotPath = `${screenshotDir}/${screenshotPrefix}-action${String(actionIndex).padStart(3, '0')}.png`;
            await page.screenshot({ path: shotPath, fullPage: false }).catch(() => {});
            entry.screenshotPath = shotPath;
        } catch (err) {
            entry.error = String(err.message || err);
            entry.timedOut = /timeout/i.test(entry.error);
            // A timeout/never-clickable exception is itself a broken-interaction
            // candidate, not a crawl-aborting error.
        }

        results.push(entry);
        if (onAction) await onAction(entry);
    }

    return results;
}
