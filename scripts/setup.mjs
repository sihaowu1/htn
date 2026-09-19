import { mkdir } from 'node:fs/promises';
await mkdir('local_website', { recursive: true });
await mkdir('logs', { recursive: true });
await mkdir('logs/orchestrator', { recursive: true });
