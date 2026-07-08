// Short source labels for citation chips (R8): the chip itself names the provenance
// ("Pharmacy", "Intake") so the doctor knows where a claim came from before clicking.
// One shared mapping — fact chips key on the citation's source_type; chat chips arrive
// with the document type projected into source_type (ChatDrawer chatCitationRef).

/** Chip spellings for the canonical SOURCE_TYPES (types.ts). Deliberately terse — these render inside a small pill. */
export const SOURCE_CHIP_LABELS: Record<string, string> = {
    intake_transcript: 'Intake',
    provider_note: 'Provider note',
    pharmacy_record: 'Pharmacy',
    imaging_report: 'Imaging report',
    lab_report: 'Lab',
    prior_visit_note: 'Prior visit',
    referral_letter: 'Referral',
    patient_self_report: 'Patient report',
    clinical_observation: 'Exam',
    external_ehr_import: 'EHR',
    scribe_transcript: 'Scribe',
};

/** Fallback for unmapped types: underscores to spaces, first letter capitalized ('clinical_note' -> 'Clinical note'). */
export function humanizeSourceType(type: string): string {
    const spaced = type.replace(/_/g, ' ').trim();
    if (spaced === '') {
        return 'Source';
    }
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The chip label for a citation's source type — mapped spelling first, humanized raw type otherwise. */
export function sourceChipLabel(type: string): string {
    return SOURCE_CHIP_LABELS[type] ?? humanizeSourceType(type);
}
