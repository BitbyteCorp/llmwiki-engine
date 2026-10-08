'use client'

import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { LayoutNode } from './context'

/** Animate layout positions, not scroll offsets; tab scrolling remains native. */
export function useTabMotion(root: RefObject<HTMLDivElement | null>, paths: string[]) {
  const previous = useRef(new Map<string, { left: number; top: number }>())
  const animations = useRef<Animation[]>([])
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    for (const animation of animations.current) animation.cancel()
    animations.current = []
    const styles = getComputedStyle(element)
    const token = styles.getPropertyValue('--motion-base').trim()
    const duration = Number.parseFloat(token) * (token.endsWith('ms') ? 1 : 1000)
    const easing = styles.getPropertyValue('--ease-out').trim() || 'ease-out'
    const next = new Map<string, { left: number; top: number }>()
    for (const tab of element.querySelectorAll<HTMLElement>('[data-tab-item]')) {
      const path = tab.dataset.tabItem!
      const position = { left: tab.offsetLeft, top: tab.offsetTop }
      const before = previous.current.get(path)
      next.set(path, position)
      if (!duration || !tab.animate) continue
      if (before) {
        const x = before.left - position.left
        const y = before.top - position.top
        if (x || y) animations.current.push(tab.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration, easing }))
      } else {
        animations.current.push(tab.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'scale(1)' }], { duration, easing }))
      }
    }
    previous.current = next
  }, [root, paths])
  useLayoutEffect(() => () => { for (const animation of animations.current) animation.cancel() }, [])
}

/** Keep split entry direction and surviving-group motion across normalized trees. */
export function useGroupMotion(root: RefObject<HTMLDivElement | null>, layout: LayoutNode, mobile: boolean) {
  const previous = useRef(new Map<string, { element: HTMLElement; bounds: DOMRect }>())
  const animations = useRef<Animation[]>([])
  useLayoutEffect(() => {
    const grid = root.current
    if (!grid) return
    const styles = getComputedStyle(grid)
    const token = styles.getPropertyValue('--motion-slow').trim()
    const duration = Number.parseFloat(token) * (token.endsWith('ms') ? 1 : 1000)
    const easing = styles.getPropertyValue('--ease-out').trim() || 'ease-out'
    const next = new Map<string, { element: HTMLElement; bounds: DOMRect }>()
    for (const element of grid.querySelectorAll<HTMLElement>('[data-workspace-group]')) {
      const id = element.dataset.workspaceGroup!
      const before = previous.current.get(id)
      // Remounting a surviving leaf must not make it look newly created.
      if (previous.current.size) for (const animation of element.getAnimations()) {
        if ('animationName' in animation && animation.animationName === 'workspace-group-enter') animation.cancel()
      }
      const bounds = element.getBoundingClientRect()
      next.set(id, { element, bounds })
      if (!duration || !element.animate || !previous.current.size) continue
      if (before && before.element !== element && !mobile && bounds.width && bounds.height) {
        const x = before.bounds.left - bounds.left
        const y = before.bounds.top - bounds.top
        const scaleX = before.bounds.width / bounds.width
        const scaleY = before.bounds.height / bounds.height
        animations.current.push(element.animate([{ transformOrigin: 'top left', transform: `translate(${x}px, ${y}px) scale(${scaleX}, ${scaleY})` }, { transformOrigin: 'top left', transform: 'translate(0, 0) scale(1, 1)' }], { duration, easing }))
      } else if (!before) {
        let origin: DOMRect | null = null
        let overlap = 0
        for (const item of previous.current.values()) {
          const area = Math.max(0, Math.min(bounds.right, item.bounds.right) - Math.max(bounds.left, item.bounds.left)) * Math.max(0, Math.min(bounds.bottom, item.bounds.bottom) - Math.max(bounds.top, item.bounds.top))
          if (area > overlap) { overlap = area; origin = item.bounds }
        }
        const dx = origin ? (bounds.left + bounds.width / 2 - origin.left - origin.width / 2) / origin.width : 0
        const dy = origin ? (bounds.top + bounds.height / 2 - origin.top - origin.height / 2) / origin.height : 1
        const horizontal = !mobile && Math.abs(dx) > Math.abs(dy)
        const x = horizontal ? (dx < 0 ? -8 : 8) : 0
        const y = horizontal ? 0 : (dy < 0 ? -8 : 8)
        animations.current.push(element.animate([{ opacity: 0, transform: `translate(${x}px, ${y}px)` }, { opacity: 1, transform: 'translate(0, 0)' }], { duration, easing }))
      }
    }
    previous.current = next
    animations.current = animations.current.filter(animation => animation.playState !== 'finished')
  }, [root, layout, mobile])
  useLayoutEffect(() => () => { for (const animation of animations.current) animation.cancel() }, [])
}
