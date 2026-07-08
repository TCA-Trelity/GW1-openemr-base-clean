// Polarity-aware delta badge, shared by the visit-summary strip and the measurement rows.
// Color follows research brief §3 must-have (measurement rows): a judgment color only where a
// rise is clearly good or bad (CST higher = worse, GC-IPL lower = worse); otherwise direction
// only — an arrow with neutral ink, no green/red claim the data can't justify.
import { Minus, TrendingDown, TrendingUp } from 'lucide-react';
import type { MetricPolarity } from './summary';

type Tone = 'good' | 'bad' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
    good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    bad: 'bg-red-50 text-red-700 border-red-200',
    neutral: 'bg-slate-50 text-slate-600 border-slate-200',
};

/** Map a signed delta + metric polarity to a good/bad/neutral tone. */
export function deltaTone(delta: number, polarity: MetricPolarity): Tone {
    if (delta === 0 || polarity === 'neutral') {
        return 'neutral';
    }
    const rising = delta > 0;
    if (polarity === 'higher_worse') {
        return rising ? 'bad' : 'good';
    }
    return rising ? 'good' : 'bad'; // lower_worse
}

function signed(delta: number): string {
    return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * A single delta chip: arrow + signed value + a caption (e.g. "vs prior", "vs base").
 * `polarity` decides the color; the arrow always follows the raw direction.
 */
export function DeltaBadge({
    delta,
    polarity,
    caption,
    unit,
    testId,
}: {
    delta: number;
    polarity: MetricPolarity;
    caption?: string;
    unit?: string;
    testId?: string;
}) {
    const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
    const tone = deltaTone(delta, polarity);
    return (
        <span
            data-testid={testId}
            className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[11px] font-medium ${TONE_CLASS[tone]}`}
        >
            <Icon className="w-3 h-3" />
            {signed(delta)}
            {unit !== undefined && unit !== '' ? unit : ''}
            {caption !== undefined && <span className="font-normal opacity-80"> {caption}</span>}
        </span>
    );
}
