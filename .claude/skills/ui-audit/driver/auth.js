import fs from 'node:fs';

const USERNAME_SELECTOR_GUESSES = [
    'input[name="username" i]', 'input[id="username" i]',
    'input[name="email" i]', 'input[id="email" i]',
    'input[autocomplete="username"]', 'input[type="email"]',
];
const PASSWORD_SELECTOR_GUESSES = [
    'input[type="password"]',
];
const SUBMIT_SELECTOR_GUESSES = [
    'button[type="submit"]', 'input[type="submit"]',
    'button:has-text("Log in")', 'button:has-text("Sign in")', 'button:has-text("Login")',
];

async function firstMatch(page, selectors) {
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.count() > 0) return locator;
    }
    return null;
}

/**
 * Applies auth to a fresh browser context before the crawl starts.
 * Returns { usedStorageState: boolean, attemptedGenericLogin: boolean, loginError: string|null }
 */
export async function applyAuth(context, page, config) {
    const auth = config.auth;
    if (!auth) {
        return { usedStorageState: false, attemptedGenericLogin: false, loginError: null };
    }

    if (auth.storageStatePath) {
        // Storage state is loaded at context-creation time by the caller (needs to happen
        // before any page exists); this branch is just a marker for the manifest.
        return { usedStorageState: true, attemptedGenericLogin: false, loginError: null };
    }

    const loginUrl = auth.loginUrl || config.baseUrl;
    const username = auth.credentialsEnv?.username ? process.env[auth.credentialsEnv.username] : auth.username;
    const password = auth.credentialsEnv?.password ? process.env[auth.credentialsEnv.password] : auth.password;

    if (!username || !password) {
        return {
            usedStorageState: false,
            attemptedGenericLogin: false,
            loginError: 'auth config present but no credentials resolved (check credentialsEnv / env vars)',
        };
    }

    try {
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

        const usernameField = auth.usernameSelector
            ? page.locator(auth.usernameSelector).first()
            : await firstMatch(page, USERNAME_SELECTOR_GUESSES);
        const passwordField = auth.passwordSelector
            ? page.locator(auth.passwordSelector).first()
            : await firstMatch(page, PASSWORD_SELECTOR_GUESSES);

        if (!usernameField || !passwordField) {
            return {
                usedStorageState: false,
                attemptedGenericLogin: true,
                loginError: 'could not locate username/password fields; supply auth.usernameSelector/passwordSelector',
            };
        }

        await usernameField.fill(username);
        await passwordField.fill(password);

        const submit = auth.submitSelector
            ? page.locator(auth.submitSelector).first()
            : await firstMatch(page, SUBMIT_SELECTOR_GUESSES);

        if (submit) {
            await Promise.all([
                page.waitForLoadState('domcontentloaded'),
                submit.click(),
            ]);
        } else {
            await passwordField.press('Enter');
            await page.waitForLoadState('domcontentloaded');
        }

        return { usedStorageState: false, attemptedGenericLogin: true, loginError: null };
    } catch (err) {
        return { usedStorageState: false, attemptedGenericLogin: true, loginError: String(err.message || err) };
    }
}

export function resolveStorageState(config) {
    const storageStatePath = config.auth?.storageStatePath;
    if (!storageStatePath) return undefined;
    if (!fs.existsSync(storageStatePath)) {
        throw new Error(`auth.storageStatePath does not exist: ${storageStatePath}`);
    }
    return storageStatePath;
}
