/**
 * Pass E: form/upload edge cases.
 *
 * Safety stance: fixture cases expected to be *rejected* by correct
 * validation (empty required fields, oversized file, wrong file type) are
 * always submitted — a proper app should reject them harmlessly, and an app
 * that doesn't is itself a real finding worth surfacing. The one case that
 * could plausibly succeed and persist real data (a *valid* file on an
 * otherwise-empty form) is only submitted when `config.submitValidUploads`
 * is explicitly enabled; by default we attach the file and capture the
 * pre-submit UI state (filename shown, preview, etc.) without pressing
 * submit.
 */

import { pickValidFixture } from './fixtures.js';

export async function enumerateForms(page) {
    return page.evaluate(() => {
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

        return Array.from(document.querySelectorAll('form')).map((form) => {
            const fileInputs = Array.from(form.querySelectorAll('input[type="file"]')).map((el) => ({
                cssPath: cssPath(el),
                name: el.getAttribute('name') || '',
                accept: el.getAttribute('accept') || '',
            }));
            const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
            return {
                cssPath: cssPath(form),
                method: (form.getAttribute('method') || 'get').toLowerCase(),
                fileInputs,
                submitCssPath: submit ? cssPath(submit) : null,
            };
        });
    });
}

async function attemptSubmit(page, form, config, entry) {
    if (!form.submitCssPath) {
        entry.submission = 'no-submit-control-found';
        return;
    }
    const beforeUrl = page.url();
    try {
        await page.locator(`css=${form.submitCssPath}`).first().click({ timeout: config.perElementWaitMs });
        await page.waitForTimeout(300);
        await page.waitForLoadState('domcontentloaded', { timeout: config.perElementWaitMs }).catch(() => {});
        entry.submission = page.url() !== beforeUrl ? 'navigated' : 'same-page';
    } catch (err) {
        entry.submission = `submit-error: ${String(err.message || err)}`;
    }
}

export async function runFormEdgeCases({ page, pageUrl, forms, config, fixtures, tracker, fileInputBudget, screenshotDir, screenshotPrefix }) {
    const results = [];
    let caseIndex = 0;

    for (const form of forms) {
        // Empty/invalid submission — tests validation clarity. Always safe to
        // attempt: a correctly validated form rejects it; one that doesn't is
        // itself the finding.
        caseIndex += 1;
        const emptyEntry = { type: 'form-empty-submit', form: { cssPath: form.cssPath }, caseIndex };
        try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: config.perElementWaitMs });
            tracker.drain();
            await attemptSubmit(page, form, config, emptyEntry);
            emptyEntry.consoleDelta = tracker.drain();
            const shotPath = `${screenshotDir}/${screenshotPrefix}-form${String(caseIndex).padStart(3, '0')}-empty.png`;
            await page.screenshot({ path: shotPath }).catch(() => {});
            emptyEntry.screenshotPath = shotPath;
        } catch (err) {
            emptyEntry.error = String(err.message || err);
        }
        results.push(emptyEntry);

        for (const fileInput of form.fileInputs) {
            if (fileInputBudget.remaining <= 0) {
                results.push({ type: 'file-input-skipped', reason: 'maxFileInputsPerRun budget exhausted', fileInput });
                continue;
            }
            fileInputBudget.remaining -= 1;

            const cases = [
                { tag: 'valid', path: pickValidFixture(fixtures, fileInput.accept), forceSubmit: config.submitValidUploads },
                { tag: 'oversized', path: fixtures.oversized, forceSubmit: true },
                { tag: 'wrong-type', path: fixtures.wrongType, forceSubmit: true },
            ];

            for (const fixtureCase of cases) {
                caseIndex += 1;
                const entry = {
                    type: 'file-upload',
                    form: { cssPath: form.cssPath },
                    fileInput: { cssPath: fileInput.cssPath, accept: fileInput.accept },
                    fixture: fixtureCase.tag,
                    caseIndex,
                };
                try {
                    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: config.perElementWaitMs });
                    tracker.drain();
                    await page.setInputFiles(`css=${fileInput.cssPath}`, fixtureCase.path);
                    await page.waitForTimeout(200);

                    if (fixtureCase.forceSubmit) {
                        await attemptSubmit(page, form, config, entry);
                    } else {
                        entry.submission = 'skipped (submitValidUploads=false)';
                    }
                    entry.consoleDelta = tracker.drain();
                    const shotPath = `${screenshotDir}/${screenshotPrefix}-form${String(caseIndex).padStart(3, '0')}-${fixtureCase.tag}.png`;
                    await page.screenshot({ path: shotPath }).catch(() => {});
                    entry.screenshotPath = shotPath;
                } catch (err) {
                    entry.error = String(err.message || err);
                }
                results.push(entry);
            }
        }
    }

    return results;
}
