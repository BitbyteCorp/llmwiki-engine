const CACHE_NAME = 'llmwiki-offline-v1'
const OFFLINE_URL = '/offline.html'
const BACKEND_PATH = /^\/(api|auth|oauth|mcp|\.well-known|healthz|readyz|metrics)(\/|$)/

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    // Only this public fallback is stored; authenticated wiki content stays on the network.
    await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((name) => name.startsWith('llmwiki-') && name !== CACHE_NAME).map((name) => caches.delete(name)))
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable()
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || request.mode !== 'navigate') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || BACKEND_PATH.test(url.pathname)) return

  event.respondWith((async () => {
    try {
      return (await event.preloadResponse) || (await fetch(request))
    } catch {
      const cache = await caches.open(CACHE_NAME)
      return (await cache.match(OFFLINE_URL)) || Response.error()
    }
  })())
})
