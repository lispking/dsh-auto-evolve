import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    hookTimeout: 20_000,
    testTimeout: 20_000,
  },
})
