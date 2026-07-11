// The agent's opening move (M9): a compact, deterministic digest of the already-gated
// brief, persisted as the first assistant message of every NEW conversation when a
// completed brief exists — so the transcript literally opens with what the agent prepared
// during check-in (visible live via the SSE `seed` event, in GET replay, and in Bruno).
// Composed from citation-gated brief content only; it is not model output, so the
// prescriptiveness lint does not apply (nothing here is generated free text).

const MAX_POINTS = 3;
const MAX_POINT_CHARS = 110;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Brief points are objects ({ text }) in current briefs, plain strings in older ones. */
function pointText(point: unknown): string | null {
    if (typeof point === 'string' && point.length > 0) {
        return point;
    }
    if (isRecord(point) && typeof point['text'] === 'string' && point['text'].length > 0) {
        return point['text'];
    }
    return null;
}

function clip(text: string): string {
    return text.length <= MAX_POINT_CHARS ? text : `${text.slice(0, MAX_POINT_CHARS - 1)}…`;
}

/**
 * Compose the opening-move digest from a stored brief's content. Returns null when the
 * content is not the expected shape (the route then simply skips seeding — absence over
 * invention, as everywhere else).
 */
export function composeOpeningMove(content: unknown, preparedAt: string): string | null {
    if (!isRecord(content)) {
        return null;
    }
    const points = Array.isArray(content['key_discussion_points'])
        ? content['key_discussion_points']
              .map(pointText)
              .filter((text): text is string => text !== null)
              .slice(0, MAX_POINTS)
        : [];
    const questionCount = Array.isArray(content['questions_to_confirm'])
        ? content['questions_to_confirm'].length
        : 0;
    const urgency = isRecord(content['urgency']) ? content['urgency'] : null;
    const urgencyLevel = urgency !== null && typeof urgency['level'] === 'string' ? urgency['level'] : null;
    const urgencyReason = urgency !== null && typeof urgency['reason'] === 'string' ? urgency['reason'] : null;

    const lines: string[] = [`I read the record during check-in (brief prepared ${preparedAt.slice(0, 10)}).`];
    if (urgencyLevel !== null && urgencyReason !== null) {
        lines.push(`Urgency: ${urgencyLevel} — ${clip(urgencyReason)}.`);
    }
    if (points.length > 0) {
        lines.push(`Worth discussing: ${points.map((text, index) => `${index + 1}) ${clip(text)}`).join(' ')}`);
    }
    if (questionCount > 0) {
        lines.push(`${questionCount} question${questionCount === 1 ? '' : 's'} queued to ask the patient.`);
    }
    lines.push('Ask me to drill in — trends, comparisons, sources; every claim stays cited.');
    return lines.join(' ');
}
