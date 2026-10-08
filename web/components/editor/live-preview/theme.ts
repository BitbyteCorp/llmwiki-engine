import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.heading], color: 'var(--primary)', fontWeight: 'bold' },
  { tag: [tags.string, tags.regexp], color: 'var(--success)' },
  { tag: [tags.number, tags.bool, tags.atom], color: 'var(--warning)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted-foreground)' },
  { tag: [tags.link, tags.url], color: 'var(--link)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--destructive)' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
]))

export function editorTheme(dark: boolean): Extension {
  return [EditorView.theme({
    '&': { height: 'auto', color: 'var(--foreground)', backgroundColor: 'var(--background)' },
    '.cm-scroller': { overflow: 'visible', overflowAnchor: 'auto' },
    '.cm-content': { caretColor: 'var(--foreground)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--accent)' },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--muted)' },
    '.cm-gutters': { color: 'var(--muted-foreground)', backgroundColor: 'var(--secondary)', borderColor: 'var(--border)' },
    '.cm-tooltip, .cm-panels': { color: 'var(--foreground)', backgroundColor: 'var(--card)', borderColor: 'var(--border)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { color: 'var(--foreground)', backgroundColor: 'var(--accent)' },
    '.cm-searchMatch': { backgroundColor: 'var(--warning)' },
    '.cm-searchMatch.cm-searchMatch-selected': { outline: '1px solid var(--ring)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-matchingBracket': { backgroundColor: 'var(--accent)', outline: '1px solid var(--border)' },
  }, { dark }), highlighting]
}

export const sourceTheme: Extension = EditorView.theme({
  '&': { height: 'auto' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'var(--font-mono)', fontVariantLigatures: 'none' },
  '.cm-content': { fontFamily: 'var(--font-mono)' },
})

export const liveTheme: Extension = EditorView.theme({
  '&': { height: 'auto', fontSize: '.875rem', lineHeight: '1.75' },
  '.cm-scroller': { overflow: 'visible', fontFamily: 'var(--font-sans)', lineHeight: '1.75' },
  '.cm-content': { width: '100%', maxWidth: '56rem', marginInline: 'auto', padding: '1rem', boxSizing: 'border-box', fontFamily: 'var(--font-sans)', overflowWrap: 'anywhere' },
  '.cm-line': { paddingInline: '0' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-live-h1, .cm-live-h2, .cm-live-h3, .cm-live-h4, .cm-live-h5, .cm-live-h6': { color: 'var(--foreground)', fontWeight: '700' },
  '.cm-live-h1': { fontSize: '1.75rem', letterSpacing: '-.02em', paddingTop: '1rem', paddingBottom: '.5rem' },
  '.cm-live-h2': { fontSize: '1.25rem', paddingTop: '2rem', paddingBottom: '.5rem' },
  '.cm-live-h3': { fontSize: '1rem', paddingTop: '1.5rem', paddingBottom: '.5rem' },
  '.cm-live-h4, .cm-live-h5, .cm-live-h6': { fontSize: '.875rem', paddingTop: '1rem', paddingBottom: '.5rem' },
  '.cm-live-emphasis': { fontStyle: 'italic' },
  '.cm-live-strong': { fontWeight: '700' },
  '.cm-live-strike': { textDecoration: 'line-through' },
  '.cm-live-code': { fontFamily: 'var(--font-mono)', fontVariantLigatures: 'none', fontSize: '.8125rem', borderRadius: '.25rem', backgroundColor: 'var(--muted)', padding: '.15rem .3rem' },
  '.cm-live-link, .cm-live-link a': { color: 'var(--link)', textDecoration: 'underline', textUnderlineOffset: '3px', cursor: 'pointer' },
  '.cm-live-unresolved, .cm-live-link[data-link-state="unresolved"], .cm-live-link [data-link-state="unresolved"]': { color: 'var(--destructive)', textDecoration: 'underline dashed', textUnderlineOffset: '3px' },
  '.cm-live-ambiguous, .cm-live-link[data-link-state="ambiguous"], .cm-live-link [data-link-state="ambiguous"]': { color: 'var(--warning)', textDecoration: 'underline wavy', textUnderlineOffset: '3px' },
  '.cm-live-link[data-link-state="pending"], .cm-live-link [data-link-state="pending"]': { color: 'var(--muted-foreground)', textDecoration: 'underline dotted' },
  '.cm-live-quote': { borderLeft: '3px solid var(--input)', paddingLeft: '1rem', color: 'var(--muted-foreground)' },
  '.cm-live-codeblock': { fontFamily: 'var(--font-mono)', fontVariantLigatures: 'none', fontSize: '.8125rem', lineHeight: '1.6', paddingInline: '1rem', borderInline: '1px solid var(--border)', backgroundColor: 'var(--code-background)', color: 'var(--foreground)' },
  '.cm-live-header, .cm-live-code-header': { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.5rem', padding: '.35rem .75rem', border: '1px solid var(--border)', borderRadius: '.5rem .5rem 0 0', backgroundColor: 'var(--code-background)', color: 'var(--muted-foreground)', fontSize: '.75rem', lineHeight: '1.5' },
  '.cm-live-lang': { color: 'var(--muted-foreground)', fontFamily: 'var(--font-sans)', fontSize: '.75rem' },
  '.cm-live-header button, .cm-live-code-header button': { padding: '.15rem .5rem', borderRadius: '.25rem', color: 'var(--foreground)', fontFamily: 'var(--font-sans)', fontSize: '.75rem' },
  '.cm-live-header button:hover, .cm-live-code-header button:hover': { backgroundColor: 'var(--background)' },
  '.cm-live-callout': { '--callout-color': 'var(--link)', marginBlock: '1rem', padding: '.85rem 1rem', border: '1px solid var(--border)', borderLeft: '3px solid var(--callout-color)', borderRadius: '.5rem', backgroundColor: 'color-mix(in srgb, var(--callout-color) 7%, var(--background))', color: 'var(--foreground)' },
  '.cm-live-callout[data-callout="warning"], .cm-live-callout[data-callout="caution"], .cm-live-callout[data-callout="attention"]': { '--callout-color': 'var(--warning)' },
  '.cm-live-callout[data-callout="danger"], .cm-live-callout[data-callout="error"], .cm-live-callout[data-callout="failure"], .cm-live-callout[data-callout="bug"]': { '--callout-color': 'var(--destructive)' },
  '.cm-live-callout[data-callout="success"], .cm-live-callout[data-callout="done"], .cm-live-callout[data-callout="tip"]': { '--callout-color': 'var(--success)' },
  '.cm-live-callout .cm-live-header': { display: 'block', padding: '0', border: '0', borderRadius: '0', backgroundColor: 'transparent', color: 'inherit', fontSize: 'inherit', fontWeight: '600' },
  '.cm-live-block, .cm-live-widget': { maxWidth: '100%', boxSizing: 'border-box', whiteSpace: 'normal', overflowWrap: 'anywhere', fontFamily: 'var(--font-sans)', fontSize: '.875rem', lineHeight: '1.75' },
  '.cm-live-block': { position: 'relative', marginBlock: '1rem' },
  '.cm-live-block > .markdown': { minWidth: '0' },
  '.cm-live-edit-block': { display: 'block', marginLeft: 'auto', marginBottom: '.25rem', padding: '.15rem .4rem', borderRadius: '.25rem', color: 'var(--muted-foreground)', backgroundColor: 'transparent', fontFamily: 'var(--font-sans)', fontSize: '.75rem', lineHeight: '1.5', cursor: 'pointer' },
  '.cm-live-edit-block:hover': { color: 'var(--foreground)', backgroundColor: 'var(--accent)' },
  '.cm-live-image': { display: 'block', maxWidth: '100%', height: 'auto', borderRadius: '.5rem' },
  '.cm-live-image img': { maxWidth: '100%', height: 'auto', borderRadius: '.5rem' },
  '.cm-live-frontmatter': { marginBlock: '0 1rem', color: 'var(--foreground)', fontFamily: 'var(--font-sans)', fontSize: '.8125rem', lineHeight: '1.5' },
  '.cm-live-hr': { display: 'block', height: '0', marginBlock: '1.5rem', border: '0', borderTop: '1px solid var(--border)' },
  '.cm-live-list': { color: 'var(--muted-foreground)', fontVariantNumeric: 'tabular-nums' },
  '.cm-live-checkbox': { width: '.875rem', height: '.875rem', margin: '0 .4rem 0 0', verticalAlign: 'middle', accentColor: 'var(--link)', cursor: 'pointer' },
  '.cm-live-link:focus-visible, .cm-live-widget button:focus-visible, .cm-live-widget a:focus-visible, .cm-live-checkbox:focus-visible, .cm-live-edit-block:focus-visible': { outline: '2px solid var(--ring)', outlineOffset: '2px' },
})
