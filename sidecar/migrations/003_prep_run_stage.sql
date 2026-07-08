-- Prep-run stage tracking: the pipeline stamps the stage it is entering, so a running
-- run shows where it is and a failed run shows where it died (GET /api/prep-runs).
ALTER TABLE prep_runs ADD COLUMN stage text;
