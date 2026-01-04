import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 120000,
    hookTimeout: 60000,
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    sequence: {
      shuffle: false
    }
  }
})
