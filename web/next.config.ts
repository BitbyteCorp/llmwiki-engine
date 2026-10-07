import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: { optimizePackageImports: ['@base-ui/react', '@tanstack/react-query', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/autocomplete', '@codemirror/language-data'] },
  turbopack: { root: fileURLToPath(new URL('..', import.meta.url)) },
}

export default nextConfig
