/**
 * Compute medication risk flags based on medication type, duration, and provider profile.
 * Verbatim logic from medicationRiskFlags.jsx:6-150.
 */
export function computeMedicationRiskFlags(medications, providerProfile = {}) {
    const flags = [];
    const specialty = (providerProfile.specialty?.subspecialty ||
        providerProfile.specialty?.primary ||
        '').toLowerCase();
    const highPriorityMeds = providerProfile.relevance_configuration?.high_priority_medications || [];
    const thresholds = providerProfile.risk_sensitivity?.thresholds || {};
    const hcqHighRiskYears = thresholds.hcq_high_risk_years || 5;
    medications.forEach((med) => {
        const medName = (med.content?.name || med.name || '').toLowerCase();
        const duration = parseDuration(med.content?.duration || med.duration);
        const dose = med.content?.dose || med.dose || '';
        // Hydroxychloroquine / Plaquenil — Retinal toxicity risk
        if (medName.includes('hydroxychloroquine') || medName.includes('plaquenil')) {
            const yearsOnMed = duration.years || 0;
            // Calculate cumulative dose estimate (200mg/day standard)
            const dailyDose = extractDailyDose(dose) || 200;
            const cumulativeDoseGrams = (dailyDose * 365 * yearsOnMed) / 1000;
            let severity = 'low';
            let message = '';
            // Use provider-configured threshold
            if (yearsOnMed >= hcqHighRiskYears || cumulativeDoseGrams >= 1000) {
                severity = 'high';
                message = `HCQ use ${yearsOnMed}+ years (est. ${Math.round(cumulativeDoseGrams)}g cumulative) — HIGH retinal toxicity risk per AAO guidelines`;
            }
            else if (yearsOnMed >= hcqHighRiskYears - 2) {
                severity = 'medium';
                message = `HCQ use ${yearsOnMed} years — approaching AAO screening threshold`;
            }
            else {
                severity = 'low';
                message = `HCQ use ${yearsOnMed} years — routine monitoring`;
            }
            flags.push({
                medication: med.content?.name || 'Hydroxychloroquine',
                flag_type: 'retinal_toxicity',
                severity,
                message,
                recommendation: severity === 'high'
                    ? 'Require annual retinal screening with 10-2 VF, SD-OCT, and FAF'
                    : 'Standard monitoring per AAO guidelines',
                source: 'AAO HCQ Screening Guidelines 2016 (revised 2020)',
                details: {
                    duration_years: yearsOnMed,
                    cumulative_dose_grams: Math.round(cumulativeDoseGrams),
                    daily_dose_mg: dailyDose,
                },
            });
        }
        // Blood thinners — Injection/procedure risk
        if (medName.includes('warfarin') ||
            medName.includes('coumadin') ||
            medName.includes('eliquis') ||
            medName.includes('apixaban') ||
            medName.includes('xarelto') ||
            medName.includes('rivaroxaban') ||
            medName.includes('plavix') ||
            medName.includes('clopidogrel') ||
            medName.includes('aspirin')) {
            flags.push({
                medication: med.content?.name || medName,
                flag_type: 'bleeding_risk',
                severity: 'medium',
                message: `On ${med.content?.name || medName} — bleeding risk for injections/procedures`,
                recommendation: specialty.includes('retina')
                    ? 'Consider timing of anti-VEGF injections; generally safe to continue but note for subretinal hemorrhage risk assessment'
                    : 'Document anticoagulation status before any procedure',
                source: 'Clinical practice',
            });
        }
        // Steroids — IOP risk
        if (medName.includes('prednisone') ||
            medName.includes('prednisolone') ||
            medName.includes('dexamethasone') ||
            medName.includes('methylprednisolone')) {
            flags.push({
                medication: med.content?.name || medName,
                flag_type: 'iop_risk',
                severity: 'medium',
                message: `On ${med.content?.name || medName} — monitor for steroid-induced IOP elevation`,
                recommendation: 'Check IOP at each visit; consider steroid-sparing alternatives if elevated',
                source: 'Clinical practice',
            });
        }
        // Flomax / Tamsulosin — IFIS risk for cataract surgery
        if (medName.includes('tamsulosin') || medName.includes('flomax')) {
            flags.push({
                medication: med.content?.name || medName,
                flag_type: 'ifis_risk',
                severity: 'high',
                message: `On ${med.content?.name || medName} — Intraoperative Floppy Iris Syndrome risk`,
                recommendation: 'Document for any planned cataract surgery; IFIS precautions required',
                source: 'AAO Cataract Surgery Guidelines',
            });
        }
        // Diabetes medications — Indicator for diabetic retinopathy screening
        if (medName.includes('metformin') ||
            medName.includes('insulin') ||
            medName.includes('glipizide') ||
            medName.includes('januvia') ||
            medName.includes('jardiance') ||
            medName.includes('ozempic')) {
            flags.push({
                medication: med.content?.name || medName,
                flag_type: 'diabetic_screening',
                severity: 'medium',
                message: `On ${med.content?.name || medName} — indicates diabetes; ensure diabetic retinopathy screening`,
                recommendation: 'Annual dilated fundus exam; document retinopathy status',
                source: 'AAO Diabetic Retinopathy Guidelines',
            });
        }
    });
    // Check provider's custom high-priority medications
    medications.forEach((med) => {
        const medName = (med.content?.name || med.name || '').toLowerCase();
        for (const customMed of highPriorityMeds) {
            if (customMed.pattern && new RegExp(customMed.pattern, 'i').test(medName)) {
                // Avoid duplicate flags
                const alreadyFlagged = flags.some((f) => f.medication.toLowerCase() === medName &&
                    f.flag_type === 'custom_priority');
                if (!alreadyFlagged) {
                    flags.push({
                        // Prototype leaves this undefined when both names are missing;
                        // '' keeps the field a string (medName is '' in that case anyway).
                        medication: med.content?.name || med.name || '',
                        flag_type: 'custom_priority',
                        severity: 'medium',
                        message: `${med.content?.name || med.name} — ${customMed.reason}`,
                        recommendation: customMed.recommendation ||
                            'Review as configured in provider settings',
                        source: 'Provider Configuration',
                        relevance_boost: customMed.relevance_boost || 0.3,
                    });
                }
                break;
            }
        }
    });
    // Sort by severity (stable sort preserves per-medication rule order within a tier)
    const severityOrder = { high: 0, medium: 1, low: 2 };
    flags.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
    return flags;
}
/**
 * Parse duration string into structured object (medicationRiskFlags.jsx:155-175).
 * Quirk preserved: when any year figure is present the months are zeroed, because the
 * prototype's "X+ years" regex also matches plain "X years" and returns early.
 */
function parseDuration(durationStr) {
    if (!durationStr) {
        return { years: 0, months: 0 };
    }
    const lower = durationStr.toLowerCase();
    // Try to extract years
    const yearMatch = lower.match(/(\d+)\s*(?:year|yr)/);
    const years = yearMatch?.[1] !== undefined ? parseInt(yearMatch[1], 10) : 0;
    // Try to extract months
    const monthMatch = lower.match(/(\d+)\s*(?:month|mo)/);
    const months = monthMatch?.[1] !== undefined ? parseInt(monthMatch[1], 10) : 0;
    // Handle "X+ years" format
    const plusYearMatch = lower.match(/(\d+)\+?\s*(?:year|yr)/);
    if (plusYearMatch?.[1] !== undefined) {
        return { years: parseInt(plusYearMatch[1], 10), months: 0 };
    }
    return { years, months };
}
/**
 * Extract daily dose in mg from a dose string (medicationRiskFlags.jsx:180-185).
 */
function extractDailyDose(doseStr) {
    if (!doseStr) {
        return null;
    }
    const match = doseStr.match(/(\d+)\s*mg/i);
    return match?.[1] !== undefined ? parseInt(match[1], 10) : null;
}
/**
 * Calculate medication duration in years — port of medicationRiskService.jsx:204-223.
 * Bridges facts that carry start_date instead of a duration string (the landed
 * MedicationContentSchema shape). Clock-injected: the prototype's `new Date()` becomes
 * the explicit `now` parameter so results are deterministic.
 * Quirk preserved: the start_date path floors days/365.25, so exactly N calendar years
 * can report N-1 when the window contains fewer leap days than N/4.
 */
export function calculateMedicationDurationYears(med, now) {
    if (med.duration) {
        const match = med.duration.match(/(\d+)\s*(year|month|week)/i);
        if (match?.[1] !== undefined && match[2] !== undefined) {
            const value = parseInt(match[1], 10);
            const unit = match[2].toLowerCase();
            if (unit.startsWith('year')) {
                return value;
            }
            if (unit.startsWith('month')) {
                return value / 12;
            }
            if (unit.startsWith('week')) {
                return value / 52;
            }
        }
    }
    const startDate = med.startDate || med.start_date;
    if (startDate) {
        const start = new Date(startDate);
        return Math.floor((now.getTime() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
    }
    return null;
}
//# sourceMappingURL=medicationRisk.js.map