'use client'

import { Fragment, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Loading } from '@/components/common'
import { Group, Panel, Separator, useGroupRef, type Layout } from 'react-resizable-panels'
import { NoteReader } from './note-reader'
import { useWorkspace, type EditorGroup, type LayoutNode, type SplitNode, type SplitSide } from './context'
import { WorkspaceTabs } from './tabs'
import { GroupDropArea } from './drop-overlay'
import { useGroupMotion } from './flip'
import { isGraphTab } from './layout'

const GraphView = dynamic(() => import('@/components/search/graph-view').then(module => module.GraphView), { ssr: false, loading: () => <Loading /> })

function nodeId(node: LayoutNode) { return node.type === 'group' ? node.groupId : node.id }

export function EditorGrid({ mobile, empty }: { mobile: boolean; empty: ReactNode }) {
  const workspace = useWorkspace()
  const root = useRef<HTMLDivElement>(null)
  useGroupMotion(root, workspace.layout, mobile)
  if (mobile) return <div ref={root} className="workspace-editor-grid workspace-mobile-groups" data-multiple={workspace.groupOrder.length > 1}>{workspace.groupOrder.map(id => <EditorPane key={id} group={workspace.groups[id]} mobile empty={empty} />)}</div>
  return <div ref={root} className="workspace-editor-grid"><LayoutBranch key={nodeId(workspace.layout)} node={workspace.layout} empty={empty} /></div>
}

function LayoutBranch({ node, empty, side }: { node: LayoutNode; empty: ReactNode; side?: SplitSide }) {
  const workspace = useWorkspace()
  if (node.type === 'group') return <EditorPane key={node.groupId} group={workspace.groups[node.groupId]} mobile={false} empty={empty} side={side} />
  return <SplitLayout key={node.id} node={node} empty={empty} />
}

function SplitLayout({ node, empty }: { node: SplitNode; empty: ReactNode }) {
  const workspace = useWorkspace()
  const groupRef = useGroupRef()
  const ids = node.children.map(nodeId)
  const desired = useMemo<Layout>(() => Object.fromEntries(node.children.map((child, index) => [nodeId(child), node.sizes[index]])), [node.children, node.sizes])
  const defaultLayout = useRef(desired)
  const appliedLayout = useRef(desired)
  useLayoutEffect(() => {
    if (Object.keys(appliedLayout.current).length === ids.length && ids.every(id => Math.abs((appliedLayout.current[id] ?? -1) - desired[id]) < .01)) return
    const changedPanels = Object.keys(appliedLayout.current).length !== ids.length || ids.some(id => !(id in appliedLayout.current))
    appliedLayout.current = desired
    if (!changedPanels) { groupRef.current?.setLayout(desired); return }
    // A replaced child (group → nested split) re-registers its Panel after this
    // effect; setting the new ids earlier throws inside the panel library.
    const frame = requestAnimationFrame(() => groupRef.current?.setLayout(desired))
    return () => cancelAnimationFrame(frame)
  }, [desired, groupRef])
  return <Group id={`workspace-split-${node.id}`} groupRef={groupRef} className="workspace-editor-split" orientation={node.orientation} defaultLayout={defaultLayout.current} resizeTargetMinimumSize={{ fine: 12, coarse: 28 }} onLayoutChanged={(layout, { isUserInteraction, requestedLayout }) => {
    if (isUserInteraction) {
      appliedLayout.current = requestedLayout ?? layout
      workspace.setSplitSizes(node.id, ids.map(id => appliedLayout.current[id]))
    }
  }}>{node.children.map((child, index) => <Fragment key={nodeId(child)}>
    {index > 0 && <Separator aria-label={node.orientation === 'horizontal' ? '편집기 그룹 너비 조절' : '편집기 그룹 높이 조절'} className="workspace-editor-separator" onDoubleClick={() => {
      const equal = Object.fromEntries(ids.map(id => [id, 100 / ids.length]))
      groupRef.current?.setLayout(equal)
      appliedLayout.current = equal
      workspace.resetSplitSizes(node.id)
    }} />}
    <Panel key={nodeId(child)} id={nodeId(child)} defaultSize={`${node.sizes[index]}%`} minSize="10%" className="workspace-editor-panel"><LayoutBranch key={nodeId(child)} node={child} empty={empty} side={node.orientation === 'horizontal' ? (index === 0 ? 'left' : 'right') : (index === 0 ? 'top' : 'bottom')} /></Panel>
  </Fragment>)}</Group>
}

function EditorPane({ group, mobile, empty, side }: { group: EditorGroup; mobile: boolean; empty: ReactNode; side?: SplitSide }) {
  const workspace = useWorkspace()
  return <section data-workspace-group={group.id} data-active={workspace.activeGroupId === group.id} data-entry-side={side ?? 'bottom'} tabIndex={-1} aria-label={`편집기 그룹 ${workspace.groupOrder.indexOf(group.id) + 1}`} className="workspace-editor-group" onFocusCapture={() => workspace.setActiveGroup(group.id)} onPointerDownCapture={() => workspace.setActiveGroup(group.id)}>
    <WorkspaceTabs group={group} />
    <GroupDropArea group={group} mobile={mobile}>{isGraphTab(group.activePath) ? <GraphView key={group.id} groupId={group.id} /> : group.activePath ? <NoteReader key={`${group.id}:${group.activePath}:${group.ref ?? 'main'}`} path={group.activePath} groupId={group.id} revisionRef={group.ref} /> : empty}</GroupDropArea>
  </section>
}
