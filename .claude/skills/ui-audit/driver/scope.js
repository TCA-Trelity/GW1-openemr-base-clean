/**
 * Resolves which pages get crawled. Two modes:
 *  - config.seedPaths given: use exactly those, no discovery.
 *  - otherwise: same-origin breadth-first crawl from config.baseUrl, following
 *    <a href> elements (optionally scoped to config.navSelector), up to maxPages.
 */

function toAbsolute(href, base) {
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

function sameOrigin(url, origin) {
    try {
        return new URL(url).origin === origin;
    } catch {
        return false;
    }
}

export async function discoverLinks(page, config, baseUrl) {
    const scopeSelector = config.navSelector || 'a[href]';
    const hrefs = await page.$$eval(scopeSelector, (els) =>
        els.map((el) => el.getAttribute('href')).filter(Boolean)
    );
    const origin = new URL(config.baseUrl).origin;
    const absolute = hrefs
        .map((h) => toAbsolute(h, baseUrl))
        .filter((u) => u && sameOrigin(u, origin))
        .map((u) => u.split('#')[0]);
    return [...new Set(absolute)];
}

export function seedQueue(config) {
    if (config.seedPaths && config.seedPaths.length) {
        return config.seedPaths.map((p) => toAbsolute(p, config.baseUrl));
    }
    return [config.baseUrl];
}
