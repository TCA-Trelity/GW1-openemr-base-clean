/**
 * Fails toward safety: matches element text/aria-label/name/class against a
 * keyword denylist. Matches are skipped by the interaction sweep, not
 * clicked, and recorded in the manifest as `skipped-destructive` entries so
 * both the vision-review stage and the user can see what was intentionally
 * left untouched.
 */
export function isDestructive(descriptor, keywords) {
    const haystack = [
        descriptor.text,
        descriptor.ariaLabel,
        descriptor.name,
        descriptor.className,
        descriptor.id,
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    return keywords.find((kw) => haystack.includes(kw.toLowerCase())) || null;
}
