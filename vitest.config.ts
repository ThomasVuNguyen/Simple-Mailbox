import { defineConfig } from 'vitest/config';

// Unit tests run in Node and cover pure logic (code extraction, PIN and lockout rules).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], environment: 'node' } });
