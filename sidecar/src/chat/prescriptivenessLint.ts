// Moved to the gate layer — the lint is part of the response-verification surface
// (src/gate/ owns every check between generation and display, ARCHITECTURE.md §4).
// This shim keeps existing import paths working.
export { lintPrescriptiveness } from '../gate/prescriptivenessLint.js';
export type { PrescriptivenessFlag, PrescriptivenessLintResult } from '../gate/prescriptivenessLint.js';
