import { Harness, MemoryAdapter } from '../sdk/index.js';

/** Local event transport used only before the SDK is connected in the pitch. */
export function createLocalAgentRuntime(): Harness {
  return new Harness(new MemoryAdapter(), { telemetryEnabled: false });
}
