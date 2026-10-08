// Imported FIRST by server tests: fixes env before any app module reads it (service.ts reads the Jev
// budget at module load). Tests never reach the real Jev: rules only unless a test opts into the mock.
process.env.JEV_MODE = 'off';
process.env.UL_JEV_BUDGET_MS = process.env.UL_TEST_JEV_BUDGET_MS ?? '1200';
process.env.UL_LOG_LEVEL ??= 'warn';
export {};
