/**
 * Pass B: console/network baseline, captured via Playwright's native event
 * listeners (not log-scraping) so it also catches failed fetch()/XHR calls
 * whose rejection is silently swallowed by app code.
 */
export function attachConsoleNetworkTracker(page) {
    const buffer = [];

    page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            buffer.push({ kind: 'console', level: msg.type(), text: msg.text() });
        }
    });

    page.on('pageerror', (err) => {
        buffer.push({ kind: 'page-error', text: String(err.message || err) });
    });

    page.on('response', (response) => {
        if (response.status() >= 400) {
            buffer.push({
                kind: 'network-error',
                url: response.url(),
                status: response.status(),
            });
        }
    });

    page.on('requestfailed', (request) => {
        buffer.push({
            kind: 'request-failed',
            url: request.url(),
            error: request.failure()?.errorText || 'unknown',
        });
    });

    return {
        /** Returns and clears everything captured since the last drain. */
        drain() {
            const events = buffer.splice(0, buffer.length);
            return events;
        },
    };
}

/**
 * Pass C: link-health check. Plain HTTP requests, no browser — cheap enough
 * to cover every discovered link without spending the interaction budget.
 * Deduplicated globally across the whole run by the caller.
 */
export async function checkLinkHealth(urls, { concurrency = 6, timeoutMs = 8000 } = {}) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < urls.length) {
            const url = urls[index];
            index += 1;
            results.push(await checkOne(url, timeoutMs));
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
    return results;
}

async function checkOne(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        if (response.status === 405 || response.status === 501) {
            response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
        }
        return { url, status: response.status, ok: response.ok, error: null };
    } catch (err) {
        return { url, status: null, ok: false, error: String(err.message || err) };
    } finally {
        clearTimeout(timer);
    }
}
