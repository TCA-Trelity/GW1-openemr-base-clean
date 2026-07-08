const DAY_MS = 1000 * 60 * 60 * 24;
const WEEK_MS = DAY_MS * 7;
// The prototype's repeated `image.image_metadata?.capture_date || image.capture_date`.
function captureDateOf(image) {
    return image.image_metadata?.capture_date || image.capture_date;
}
// new Date(undefined) in the prototype yields Invalid Date; NaN reproduces that exactly.
function captureTimeOf(image) {
    return new Date(captureDateOf(image) ?? NaN).getTime();
}
/**
 * Compute treatment context for an image (imagingAnalysis.jsx:315-346):
 * days since the most recent treatment strictly before the capture date.
 */
export function computeTreatmentContext(captureDate, treatments) {
    const imageDate = new Date(captureDate);
    // Find most recent treatment before this image
    const priorTreatments = treatments
        .filter((t) => new Date(t.treatment_date).getTime() < imageDate.getTime())
        .sort((a, b) => new Date(b.treatment_date).getTime() - new Date(a.treatment_date).getTime());
    const lastTreatment = priorTreatments[0];
    if (!lastTreatment) {
        return {
            days_since_last_treatment: null,
            last_treatment: null,
            interval_from_prior_image: null,
            treatment_cycle_number: 1,
        };
    }
    const daysSince = Math.floor((imageDate.getTime() - new Date(lastTreatment.treatment_date).getTime()) / DAY_MS);
    return {
        days_since_last_treatment: daysSince,
        last_treatment: {
            medication: lastTreatment.injection_details?.medication || lastTreatment.treatment_type,
            date: lastTreatment.treatment_date,
            dose: lastTreatment.injection_details?.dose,
        },
        interval_from_prior_image: null, // Computed separately
        treatment_cycle_number: lastTreatment.injection_details?.injection_number || 1,
    };
}
/**
 * Compute the deterministic diff between current and prior analysis
 * (imagingAnalysis.jsx:161-254): resolved/new findings, CRT delta > 20 microns,
 * overall change, and the treatment-response classification.
 */
export function computeComparison(currentFindings, currentMeasurements, priorAnalysis, treatmentContext) {
    const changes = [];
    // Compare findings
    const priorFindingTypes = new Set(priorAnalysis.findings?.map((f) => f.finding_type) || []);
    const currentFindingTypes = new Set(currentFindings.map((f) => f.finding_type));
    // Check for resolved findings
    priorFindingTypes.forEach((type) => {
        if (!currentFindingTypes.has(type) && type !== 'normal') {
            changes.push({
                finding_type: type,
                change_type: 'resolved',
                description: `${formatFindingType(type)} has resolved`,
            });
        }
    });
    // Check for new findings
    currentFindingTypes.forEach((type) => {
        if (!priorFindingTypes.has(type) && type !== 'normal') {
            changes.push({
                finding_type: type,
                change_type: 'new',
                description: `New ${formatFindingType(type)} detected`,
            });
        }
    });
    // Compare measurements
    const priorCRT = priorAnalysis.measurements?.find((m) => m.measurement_type === 'central_retinal_thickness');
    const currentCRT = currentMeasurements.find((m) => m.measurement_type === 'central_retinal_thickness');
    if (priorCRT && currentCRT) {
        const measurementDelta = currentCRT.value - priorCRT.value;
        if (Math.abs(measurementDelta) > 20) {
            changes.push({
                finding_type: 'central_retinal_thickness',
                change_type: measurementDelta > 0 ? 'worsened' : 'improved',
                description: `CRT ${measurementDelta > 0 ? 'increased' : 'decreased'} by ${Math.abs(measurementDelta)} microns`,
                measurement_delta: measurementDelta,
            });
        }
    }
    // Determine overall change
    let overallChange = 'stable';
    const hasImproved = changes.some((c) => c.change_type === 'resolved' || c.change_type === 'improved');
    const hasWorsened = changes.some((c) => c.change_type === 'new' || c.change_type === 'worsened');
    if (hasImproved && hasWorsened) {
        overallChange = 'mixed';
    }
    else if (hasImproved) {
        overallChange = 'improved';
    }
    else if (hasWorsened) {
        overallChange = 'worsened';
    }
    // Assess treatment response
    let treatmentResponse = {
        assessment: 'no_response',
        confidence: 0.7,
        rationale: '',
    };
    // Truthiness check preserved from the prototype: 0 days-since (or null) keeps the
    // default no_response classification.
    if (treatmentContext.days_since_last_treatment) {
        const weeksSince = Math.floor(treatmentContext.days_since_last_treatment / 7);
        if (overallChange === 'improved' ||
            (overallChange === 'stable' && !currentFindingTypes.has('subretinal_fluid'))) {
            treatmentResponse = {
                assessment: 'good_response',
                confidence: 0.85,
                rationale: `Macula dry at ${weeksSince} weeks post-treatment`,
            };
        }
        else if (overallChange === 'worsened') {
            treatmentResponse = {
                assessment: 'worsened',
                confidence: 0.82,
                rationale: `Fluid recurrence at ${weeksSince} weeks — may need shorter interval`,
            };
        }
        else if (overallChange === 'stable' && currentFindingTypes.has('subretinal_fluid')) {
            treatmentResponse = {
                assessment: 'partial_response',
                confidence: 0.75,
                rationale: 'Persistent fluid but not worsened',
            };
        }
    }
    return {
        prior_image_id: priorAnalysis.image_id,
        prior_image_date: priorAnalysis.capture_date,
        interval_days: treatmentContext.interval_from_prior_image,
        overall_change: overallChange,
        changes,
        treatment_response: treatmentResponse,
    };
}
/**
 * Analyze treatment interval patterns (imagingAnalysis.jsx:351-431): match each image to
 * its preceding treatment, then derive the optimal interval from the longest stable
 * interval vs the shortest leaking interval. Confidence: >=5 samples high, >=3 medium.
 */
export function analyzeIntervalPatterns(images, treatments) {
    if (images.length === 0) {
        return {
            intervals: [],
            pattern_summary: {
                total_cycles: 0,
                good_response_count: 0,
                poor_response_count: 0,
                average_interval: null,
            },
            optimal_interval: null,
            recommendation: '',
            confidence: 'low',
        };
    }
    const intervals = [];
    // Match each image with its preceding treatment
    images.forEach((image) => {
        const imageTime = captureTimeOf(image);
        const priorTreatment = treatments
            .filter((t) => new Date(t.treatment_date).getTime() < imageTime)
            .sort((a, b) => new Date(b.treatment_date).getTime() -
            new Date(a.treatment_date).getTime())[0];
        const response = image.ai_analysis?.comparison_to_prior?.treatment_response;
        if (priorTreatment && response) {
            const intervalWeeks = Math.floor((imageTime - new Date(priorTreatment.treatment_date).getTime()) / WEEK_MS);
            intervals.push({
                interval_weeks: intervalWeeks,
                outcome: response.assessment,
                image_date: captureDateOf(image),
                treatment_date: priorTreatment.treatment_date,
                medication: priorTreatment.injection_details?.medication,
            });
        }
    });
    // Analyze patterns
    const goodOutcomes = intervals.filter((i) => i.outcome === 'good_response');
    const badOutcomes = intervals.filter((i) => i.outcome === 'worsened' || i.outcome === 'no_response');
    // Find optimal interval
    let optimalInterval = null;
    let recommendation = '';
    if (intervals.length >= 2) {
        // Find longest interval with good outcome
        const maxGoodInterval = goodOutcomes.length > 0 ? Math.max(...goodOutcomes.map((i) => i.interval_weeks)) : null;
        // Find shortest interval with bad outcome
        const minBadInterval = badOutcomes.length > 0 ? Math.min(...badOutcomes.map((i) => i.interval_weeks)) : null;
        if (maxGoodInterval && minBadInterval) {
            optimalInterval = maxGoodInterval;
            recommendation = `Patient stable at ${maxGoodInterval} weeks but leaked at ${minBadInterval} weeks. Recommend ${maxGoodInterval}-week intervals.`;
        }
        else if (maxGoodInterval) {
            optimalInterval = maxGoodInterval;
            recommendation = `Patient consistently stable at ${maxGoodInterval}-week intervals. Consider extending to ${maxGoodInterval + 2} weeks.`;
        }
        else if (minBadInterval) {
            optimalInterval = Math.max(4, minBadInterval - 2);
            recommendation = `Patient leaked at ${minBadInterval} weeks. Recommend shortening to ${optimalInterval}-week intervals.`;
        }
    }
    return {
        intervals,
        pattern_summary: {
            total_cycles: intervals.length,
            good_response_count: goodOutcomes.length,
            poor_response_count: badOutcomes.length,
            average_interval: intervals.length > 0
                ? Math.round(intervals.reduce((sum, i) => sum + i.interval_weeks, 0) /
                    intervals.length)
                : null,
        },
        optimal_interval: optimalInterval,
        recommendation,
        confidence: intervals.length >= 5 ? 'high' : intervals.length >= 3 ? 'medium' : 'low',
    };
}
/**
 * Detect HCQ toxicity progression across serial images (imagingAnalysis.jsx:436-523):
 * ganglion-cell decline >= 10 microns first-to-last -> progression (>= 15 -> high alert);
 * any step-up in RPE finding severity -> progression + high alert.
 */
export function analyzeHCQProgression(images) {
    if (images.length === 0) {
        return {
            gc_thickness_trend: [],
            rpe_changes_trend: [],
            progression_detected: false,
            progression_description: '',
            alert_level: 'low',
            recommendation: 'Continue routine HCQ monitoring per AAO guidelines',
        };
    }
    // Sort by date
    const sortedImages = [...images].sort((a, b) => captureTimeOf(a) - captureTimeOf(b));
    const gcThicknessOverTime = [];
    const rpeChangesOverTime = [];
    sortedImages.forEach((image) => {
        const gcMeasurement = image.ai_analysis?.measurements?.find((m) => m.measurement_type === 'ganglion_cell_thickness');
        const rpeFinding = image.ai_analysis?.findings?.find((f) => f.finding_type === 'rpe_changes' || f.finding_type === 'retinal_thinning');
        if (gcMeasurement) {
            gcThicknessOverTime.push({
                date: captureDateOf(image),
                value: gcMeasurement.value,
                image_id: image.id,
            });
        }
        if (rpeFinding) {
            rpeChangesOverTime.push({
                date: captureDateOf(image),
                severity: rpeFinding.severity,
                confidence: rpeFinding.confidence,
                image_id: image.id,
            });
        }
    });
    // Detect progression
    let progressionDetected = false;
    let progressionDescription = '';
    let alertLevel = 'low';
    const firstGc = gcThicknessOverTime[0];
    const lastGc = gcThicknessOverTime[gcThicknessOverTime.length - 1];
    if (gcThicknessOverTime.length >= 2 && firstGc !== undefined && lastGc !== undefined) {
        const decline = firstGc.value - lastGc.value;
        if (decline >= 10) {
            progressionDetected = true;
            progressionDescription = `Ganglion cell layer thinning of ${decline} microns detected over ${gcThicknessOverTime.length} images`;
            alertLevel = decline >= 15 ? 'high' : 'medium';
        }
    }
    if (rpeChangesOverTime.length >= 2) {
        const severityProgression = rpeChangesOverTime.some((r, i) => i > 0 &&
            severityToNumber(r.severity) >
                severityToNumber(rpeChangesOverTime[i - 1]?.severity));
        if (severityProgression) {
            progressionDetected = true;
            progressionDescription += progressionDescription ? '. ' : '';
            progressionDescription += 'Progressive RPE changes noted across serial images';
            alertLevel = 'high';
        }
    }
    return {
        gc_thickness_trend: gcThicknessOverTime,
        rpe_changes_trend: rpeChangesOverTime,
        progression_detected: progressionDetected,
        progression_description: progressionDescription,
        alert_level: alertLevel,
        recommendation: progressionDetected
            ? 'Consider rheumatology consultation regarding HCQ discontinuation'
            : 'Continue routine HCQ monitoring per AAO guidelines',
    };
}
const SEVERITY_RANK = { mild: 1, moderate: 2, severe: 3 };
/**
 * Rank a finding severity (imagingAnalysis.jsx:580-582); unknown/absent ranks 0.
 */
export function severityToNumber(severity) {
    return (severity !== undefined && SEVERITY_RANK[severity]) || 0;
}
const FINDING_TYPE_LABELS = {
    subretinal_fluid: 'Subretinal fluid',
    intraretinal_fluid: 'Intraretinal fluid',
    pigment_epithelial_detachment: 'PED',
    drusen: 'Drusen',
    geographic_atrophy: 'Geographic atrophy',
    retinal_thinning: 'Retinal thinning',
    rpe_changes: 'RPE changes',
    epiretinal_membrane: 'Epiretinal membrane',
    vitreomacular_traction: 'Vitreomacular traction',
    macular_hole: 'Macular hole',
    hemorrhage: 'Hemorrhage',
    exudate: 'Exudate',
    normal: 'Normal',
};
// Display label for a finding type (imagingAnalysis.jsx:537-554); computeComparison
// embeds these labels in its change descriptions, so the mapping is part of the engine.
function formatFindingType(type) {
    return FINDING_TYPE_LABELS[type] || type;
}
//# sourceMappingURL=imagingAnalysis.js.map