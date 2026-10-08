import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: { optimizePackageImports: ['@base-ui/react', '@tanstack/react-query', '@codemirror/state', '@codemirror/view', '@codemirror/language', '@codemirror/autocomplete', '@codemirror/language-data'] },
  turbopack: { root: fileURLToPath(new URL('..', import.meta.url)) },
  async headers() {
    return [
      { source: '/sw.js', headers: [{ key: 'Content-Type', value: 'application/javascript; charset=utf-8' }, { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }] },
      { source: '/offline.html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
    ]
  },
}

export default nextConfig
