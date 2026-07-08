// Trends sub-tab — port of TrendAnalysis.jsx's two LineCharts (CRT + ganglion cell), grid
// and tooltip recolored for the panel's light surface. Series extraction is display math;
// the HCQ progression judgment renders from the brief (server-computed), never here.
import { AlertTriangle, CheckCircle, TrendingUp } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { HcqProgressionAnalysis, ImageRecord } from '../types';
import { Card } from '../ui';

export interface SeriesPoint {
    date: string;
    dateLabel: string;
    value: number;
}

/** Extract one measurement series from image records, sorted by capture date ascending. */
export function extractMeasurementSeries(
    images: ImageRecord[],
    measurementType: string,
    labelStyle: 'day' | 'month-year' = 'day',
): SeriesPoint[] {
    const labelOptions: Intl.DateTimeFormatOptions =
        labelStyle === 'day' ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' };
    return images
        .flatMap((image) => {
            const measurement = image.ai_analysis?.measurements?.find((m) => m.measurement_type === measurementType);
            return measurement === undefined ? [] : [{ date: image.image_metadata.capture_date, value: measurement.value }];
        })
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
        .map((point) => ({ ...point, dateLabel: new Date(point.date).toLocaleDateString('en-US', labelOptions) }));
}

// Light-surface translation of the prototype's dark chart chrome (#334155 grid, #1e293b
// tooltip); series/threshold strokes are kept verbatim. Threshold labels use the darker
// -700 ink of the same hue so the label text clears contrast on white.
const GRID_STROKE = '#e2e8f0'; // slate-200 (was #334155 on slate-800)
const AXIS_STROKE = '#64748b'; // slate-500 (unchanged)
const TOOLTIP_STYLE = { backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px' } as const;
const TOOLTIP_LABEL_STYLE = { color: '#64748b' } as const;

function CrtChart({ data }: { data: SeriesPoint[] }) {
    return (
        <Card className="p-5">
            <h3 className="text-base font-semibold text-slate-800 mb-3">Central Retinal Thickness Over Time</h3>
            <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                        <XAxis dataKey="dateLabel" stroke={AXIS_STROKE} fontSize={12} />
                        <YAxis stroke={AXIS_STROKE} fontSize={12} domain={['auto', 'auto']} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
                        {/* Normal range references (TrendAnalysis.jsx: 280/240 µm) */}
                        <ReferenceLine y={280} stroke="#22c55e" strokeDasharray="3 3" label={{ value: 'Upper Normal', fill: '#15803d', fontSize: 10 }} />
                        <ReferenceLine y={240} stroke="#22c55e" strokeDasharray="3 3" label={{ value: 'Lower Normal', fill: '#15803d', fontSize: 10 }} />
                        <Line
                            type="monotone"
                            dataKey="value"
                            name="CRT (µm)"
                            stroke="#3b82f6"
                            strokeWidth={2}
                            dot={{ fill: '#3b82f6', strokeWidth: 2, r: 4 }}
                            activeDot={{ r: 6, fill: '#60a5fa' }}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <p className="text-xs text-slate-500 mt-2">Central retinal thickness (microns) — dashed lines mark the normal range</p>
        </Card>
    );
}

function GcChart({ data, hcq }: { data: SeriesPoint[]; hcq: HcqProgressionAnalysis }) {
    const lineColor = hcq.progression_detected ? '#ef4444' : '#22c55e';
    return (
        <Card className={`p-5 ${hcq.progression_detected ? 'bg-red-50/60 border-red-200' : ''}`}>
            <h3 className="text-base font-semibold text-slate-800 mb-3 flex items-center gap-2">
                {hcq.progression_detected ? (
                    <AlertTriangle className="w-5 h-5 text-red-600" />
                ) : (
                    <CheckCircle className="w-5 h-5 text-emerald-600" />
                )}
                HCQ Toxicity Monitoring
            </h3>
            {hcq.progression_detected && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 mb-4">
                    <p className="text-sm font-medium text-red-800">{hcq.progression_description}</p>
                    {hcq.recommendation !== '' && <p className="text-sm text-red-700 mt-1">{hcq.recommendation}</p>}
                </div>
            )}
            <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
                        <XAxis dataKey="dateLabel" stroke={AXIS_STROKE} fontSize={12} />
                        <YAxis stroke={AXIS_STROKE} fontSize={12} domain={[60, 100]} />
                        <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL_STYLE} />
                        <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="3 3" label={{ value: 'Lower Normal', fill: '#b91c1c', fontSize: 10 }} />
                        <Line
                            type="monotone"
                            dataKey="value"
                            name="GC thickness (µm)"
                            stroke={lineColor}
                            strokeWidth={2}
                            dot={{ fill: lineColor, strokeWidth: 2, r: 4 }}
                        />
                    </LineChart>
                </ResponsiveContainer>
            </div>
            <p className="text-xs text-slate-500 mt-2">
                Ganglion Cell Layer thickness (microns) — decline may indicate early HCQ toxicity
            </p>
        </Card>
    );
}

export default function Trends({ images, hcq }: { images: ImageRecord[]; hcq: HcqProgressionAnalysis }) {
    const crtData = extractMeasurementSeries(images, 'central_retinal_thickness', 'day');
    const gcData = extractMeasurementSeries(images, 'ganglion_cell_thickness', 'month-year');

    if (crtData.length === 0 && gcData.length === 0) {
        return (
            <div className="text-center py-12 text-slate-400">
                <TrendingUp className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm font-medium text-slate-500">Not enough data to show trends</p>
                <p className="text-xs mt-1">More images are needed for trend analysis</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {crtData.length > 0 && <CrtChart data={crtData} />}
            {gcData.length > 0 && <GcChart data={gcData} hcq={hcq} />}
        </div>
    );
}
