// Barrel + registry for the read-only chat tools (TC1; get_imaging_overview added by IC1).
// ChatService drives these by name in its tool-use loop; import the registry from here.
import type { RegisteredTool } from './types.js';
import { getFullDocument } from './getFullDocument.js';
import { getMeasurementTrend } from './getMeasurementTrend.js';
import { compareScans } from './compareScans.js';
import { getImagingOverview } from './getImagingOverview.js';
import { checkMedRisk } from './checkMedRisk.js';
import { searchRecord } from './searchRecord.js';
import { getOpenQuestions } from './getOpenQuestions.js';

export * from './types.js';
export { getFullDocument, getFullDocumentOutputSchema } from './getFullDocument.js';
export { getMeasurementTrend, getMeasurementTrendOutputSchema } from './getMeasurementTrend.js';
export { compareScans, compareScansOutputSchema } from './compareScans.js';
export { getImagingOverview, getImagingOverviewOutputSchema } from './getImagingOverview.js';
export { checkMedRisk, checkMedRiskOutputSchema } from './checkMedRisk.js';
export { searchRecord, searchRecordOutputSchema } from './searchRecord.js';
export { getOpenQuestions, getOpenQuestionsOutputSchema } from './getOpenQuestions.js';

/** The default tool set every ChatService loads unless a caller injects its own. */
export const ALL_CHAT_TOOLS: readonly RegisteredTool[] = [
    getFullDocument,
    getMeasurementTrend,
    compareScans,
    getImagingOverview,
    checkMedRisk,
    searchRecord,
    getOpenQuestions,
];
