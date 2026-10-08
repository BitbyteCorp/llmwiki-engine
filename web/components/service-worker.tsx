'use client'

import { useEffect } from 'react'

export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return

    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(
        registrations.filter((registration) => [registration.installing, registration.waiting, registration.active].some((worker) => worker && new URL(worker.scriptURL).pathname === '/sw.js')).map((registration) => registration.unregister()),
      )).catch((error: unknown) => console.warn('Failed to unregister the LLM Wiki service worker', error))
      return
    }

    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((error: unknown) => console.warn('Failed to register the LLM Wiki service worker', error))
    }
    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })
    return () => window.removeEventListener('load', register)
  }, [])

  return null
}
