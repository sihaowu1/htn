import type { Harness, StoreAdapter } from '../sdk/index.js';
import { createLocalAgentRuntime } from './local-runtime.js';

/**
 * Demo integration seam.
 *
 * The default demo environment intentionally keeps agent evidence local and
 * disables telemetry export. During the live pitch, replace the body with:
 *
 *   import { Harness } from '../sdk/index.js';
 *   return new Harness(watchtowerStore);
 *
 * That single change connects the existing Start Run button to Watchtower's
 * durable event store and Sentry telemetry. The normal application never uses
 * this file.
 */
export function createDemoHarness(_watchtowerStore: StoreAdapter): Harness {
  return createLocalAgentRuntime();
}
