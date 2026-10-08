// Feature route plugins registered by buildApp() after the core API (see src/server/context.ts).
// To add a feature: create src/server/routes/<feature>.ts exporting `defineRoutes('<feature>', ...)`,
// import it here and append it to FEATURE_ROUTES. Order = registration order; a duplicate route fails fast.
import type { UlRoutePlugin } from '../context.ts';

export const FEATURE_ROUTES: UlRoutePlugin[] = [];
