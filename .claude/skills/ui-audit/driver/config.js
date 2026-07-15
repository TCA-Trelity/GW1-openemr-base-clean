import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_BREAKPOINTS = [
    { label: 'mobile', width: 375, height: 812 },
    { label: 'tablet', width: 768, height: 1024 },
    { label: 'laptop', width: 1280, height: 800 },
    { label: 'desktop', width: 1920, height: 1080 },
];

export const DEFAULT_DESTRUCTIVE_KEYWORDS = [
    'delete', 'remove', 'destroy', 'purge', 'logout', 'log out', 'sign out',
    'deactivate', 'void', 'permanently', 'cancel account', 'terminate',
    'unsubscribe', 'wipe', 'reset all', 'clear all',
];

export const DEFAULTS = {
    maxPages: 8,
    maxPagesHardCap: 20,
    maxActionsPerPage: 15,
    maxActionsPerPageHardCap: 30,
    maxFileInputsPerRun: 3,
    maxFileInputsHardCap: 6,
    perElementWaitMs: 10_000,
    timeBudgetMs: 15 * 60_000,
    timeBudgetHardCapMs: 30 * 60_000,
    oversizedFixtureMb: 12,
    submitValidUploads: false,
};

function readJsonIfExists(filePath) {
    if (!filePath) return {};
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Config file not found: ${resolved}`);
    }
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function parseArgs(argv) {
    const args = { _: [] };
    for (const raw of argv) {
        if (raw.startsWith('--')) {
            const eq = raw.indexOf('=');
            if (eq === -1) {
                args[raw.slice(2)] = true;
            } else {
                args[raw.slice(2, eq)] = raw.slice(eq + 1);
            }
        } else {
            args._.push(raw);
        }
    }
    return args;
}

function parseViewportList(str) {
    // "375x812:mobile,768x1024:tablet"
    return str.split(',').map((chunk) => {
        const [dims, label] = chunk.split(':');
        const [width, height] = dims.split('x').map(Number);
        return { width, height, label: label || `${width}x${height}` };
    });
}

export function loadConfig(argv) {
    const args = parseArgs(argv);
    const fileConfig = readJsonIfExists(args.config);

    const target = args.url || fileConfig.baseUrl;
    if (!target) {
        throw new Error(
            'No target URL given. Pass --url=<start-url> or set "baseUrl" in --config=<path>.'
        );
    }

    const breakpoints = args.viewports
        ? parseViewportList(args.viewports)
        : fileConfig.breakpoints && fileConfig.breakpoints.length
            ? fileConfig.breakpoints
            : DEFAULT_BREAKPOINTS;

    const maxPages = Math.min(
        Number(args['max-pages'] || fileConfig.maxPages || DEFAULTS.maxPages),
        DEFAULTS.maxPagesHardCap
    );
    const maxActionsPerPage = Math.min(
        Number(fileConfig.maxActionsPerPage || DEFAULTS.maxActionsPerPage),
        DEFAULTS.maxActionsPerPageHardCap
    );
    const maxFileInputsPerRun = Math.min(
        Number(fileConfig.maxFileInputsPerRun || DEFAULTS.maxFileInputsPerRun),
        DEFAULTS.maxFileInputsHardCap
    );
    const timeBudgetMs = Math.min(
        Number(fileConfig.timeBudgetMs || DEFAULTS.timeBudgetMs),
        DEFAULTS.timeBudgetHardCapMs
    );

    const outDir = path.resolve(
        args['out-dir'] ||
            fileConfig.outDir ||
            path.join(process.cwd(), 'ui-audit-runs', String(args['run-id'] || Date.now()))
    );

    return {
        baseUrl: target,
        auth: fileConfig.auth || null,
        destructiveKeywords: [
            ...DEFAULT_DESTRUCTIVE_KEYWORDS,
            ...(fileConfig.destructiveKeywords || []),
        ],
        breakpoints,
        seedPaths: fileConfig.seedPaths || null,
        navSelector: fileConfig.navSelector || null,
        maxPages,
        maxActionsPerPage,
        maxFileInputsPerRun,
        perElementWaitMs: fileConfig.perElementWaitMs || DEFAULTS.perElementWaitMs,
        timeBudgetMs,
        uploadFixtureOverrides: fileConfig.uploadFixtureOverrides || {},
        oversizedFixtureMb: fileConfig.oversizedFixtureMb || DEFAULTS.oversizedFixtureMb,
        submitValidUploads: fileConfig.submitValidUploads ?? DEFAULTS.submitValidUploads,
        outDir,
        skillRoot: SKILL_ROOT,
        headless: args.headed ? false : true,
    };
}
