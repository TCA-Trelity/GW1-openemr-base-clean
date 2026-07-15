#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadConfig } from './config.js';
import { applyAuth, resolveStorageState } from './auth.js';
import { seedQueue, discoverLinks } from './scope.js';
import { scanDomAnomalies } from './heuristics.js';
import { attachConsoleNetworkTracker, checkLinkHealth } from './network.js';
import { enumerateInteractiveElements, runInteractionSweep } from './interaction.js';
import { enumerateForms, runFormEdgeCases } from './forms.js';
import { resolveFixtures } from './fixtures.js';
import { Manifest } from './manifest.js';

/**
 * Some environments pre-install a Chromium build at a fixed path (via
 * PLAYWRIGHT_BROWSERS_PATH) that doesn't match the exact revision this
 * package.json's Playwright version expects to auto-detect. Prefer that
 * pre-install when present; otherwise fall back to Playwright's own
 * resolution (which downloads its expected browser on demand).
 */
function resolveExecutablePath() {
    const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (!browsersPath) return undefined;
    const candidate = path.join(browsersPath, 'chromium');
    return fs.existsSync(candidate) ? candidate : undefined;
}

async function main() {
    const config = loadConfig(process.argv.slice(2));
    const manifest = new Manifest(config.outDir);
    const startTime = Date.now();
    const fixtures = resolveFixtures(config);
    const fileInputBudget = { remaining: config.maxFileInputsPerRun };

    const browser = await chromium.launch({
        headless: config.headless,
        executablePath: resolveExecutablePath(),
    });
    const contextOptions = {};
    const storageState = resolveStorageState(config);
    if (storageState) contextOptions.storageState = storageState;

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const tracker = attachConsoleNetworkTracker(page);

    const authResult = await applyAuth(context, page, config);
    manifest.append({ type: 'auth', ...authResult });
    tracker.drain(); // discard login-page noise; it isn't part of the audited surface

    const visited = new Set();
    const discoveredLinks = new Set();
    const queue = seedQueue(config);
    let pageIndex = 0;
    let truncatedReason = null;

    function timeExceeded() {
        return Date.now() - startTime > config.timeBudgetMs;
    }

    while (queue.length && pageIndex < config.maxPages) {
        if (timeExceeded()) {
            truncatedReason = 'time-budget';
            break;
        }
        const url = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);
        pageIndex += 1;
        const pageTag = `p${String(pageIndex).padStart(3, '0')}`;

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.perElementWaitMs });
        } catch (err) {
            manifest.append({ type: 'page-load-error', pageIndex, url, error: String(err.message || err) });
            continue;
        }

        if (!config.seedPaths) {
            const links = await discoverLinks(page, config, url).catch((err) => {
                manifest.append({ type: 'enumeration-error', pass: 'link-discovery', pageIndex, url, error: String(err.message || err) });
                return [];
            });
            for (const link of links) {
                discoveredLinks.add(link);
                if (!visited.has(link) && !queue.includes(link)) queue.push(link);
            }
        }

        for (const [viewportIndex, viewport] of config.breakpoints.entries()) {
            if (timeExceeded()) {
                truncatedReason = 'time-budget';
                break;
            }
            const viewportTag = `${pageTag}-${viewport.label}`;
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page
                .goto(url, { waitUntil: 'domcontentloaded', timeout: config.perElementWaitMs })
                .catch((err) => manifest.append({ type: 'page-load-error', pageIndex, url, viewport: viewport.label, error: String(err.message || err) }));
            tracker.drain();

            const heuristicFlags = await scanDomAnomalies(page).catch((err) => {
                manifest.append({ type: 'enumeration-error', pass: 'dom-scan', pageIndex, url, viewport: viewport.label, error: String(err.message || err) });
                return [];
            });
            const screenshotPath = path.join(manifest.screensDir, `${viewportTag}.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
            manifest.append({
                type: 'screen',
                pageIndex,
                url,
                viewport: viewport.label,
                width: viewport.width,
                height: viewport.height,
                screenshotPath,
                heuristicFlags,
            });

            // Interaction sweep and form edge cases only run at the base
            // (first configured) viewport — repeating the full click/upload
            // budget at every breakpoint would blow the action budget for
            // little extra signal; layout is still checked at every viewport
            // via the screenshot + DOM scan above.
            if (viewportIndex === 0) {
                const candidates = await enumerateInteractiveElements(page).catch((err) => {
                    manifest.append({ type: 'enumeration-error', pass: 'interaction', pageIndex, url, error: String(err.message || err) });
                    return [];
                });
                const interactionResults = await runInteractionSweep({
                    page,
                    pageUrl: url,
                    candidates,
                    config,
                    tracker,
                    screenshotDir: manifest.screensDir,
                    screenshotPrefix: viewportTag,
                });
                for (const result of interactionResults) {
                    manifest.append({ pageIndex, url, viewport: viewport.label, ...result });
                }

                const forms = await enumerateForms(page).catch((err) => {
                    manifest.append({ type: 'enumeration-error', pass: 'forms', pageIndex, url, error: String(err.message || err) });
                    return [];
                });
                if (forms.length) {
                    const formResults = await runFormEdgeCases({
                        page,
                        pageUrl: url,
                        forms,
                        config,
                        fixtures,
                        tracker,
                        fileInputBudget,
                        screenshotDir: manifest.screensDir,
                        screenshotPrefix: viewportTag,
                    });
                    for (const result of formResults) {
                        manifest.append({ pageIndex, url, viewport: viewport.label, ...result });
                    }
                }
            }
        }
    }

    if (!truncatedReason && queue.length && pageIndex >= config.maxPages) {
        truncatedReason = 'max-pages';
    }

    const linkList = [...discoveredLinks];
    if (linkList.length) {
        const health = await checkLinkHealth(linkList);
        for (const result of health) manifest.append({ type: 'link-health', ...result });
    }

    await browser.close();

    const summary = manifest.writeSummary({
        baseUrl: config.baseUrl,
        pagesVisited: pageIndex,
        pagesQueued: queue.length,
        linksDiscovered: linkList.length,
        truncated: Boolean(truncatedReason),
        truncatedReason,
        breakpoints: config.breakpoints,
        maxPages: config.maxPages,
        maxActionsPerPage: config.maxActionsPerPage,
        durationMs: Date.now() - startTime,
    });
    manifest.close();

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    if (truncatedReason) {
        // eslint-disable-next-line no-console
        console.error(`ui-audit run truncated: ${truncatedReason} (see run-summary.json for details)`);
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
});
