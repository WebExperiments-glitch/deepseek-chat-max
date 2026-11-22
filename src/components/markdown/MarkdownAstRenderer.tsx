import { createElement, memo, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import clsx from 'clsx'
import type {
  BlockContent,
  Blockquote as BlockquoteNode,
  DefinitionContent,
  List as ListNode,
  Paragraph,
  PhrasingContent,
  Root,
  Table as TableNode,
} from 'mdast'
import { CitationLink } from '../search/CitationLink.js'
import { CodeBlock } from './CodeBlock.js'
import { ImageAsLink, Link } from './Link.js'
import { InlineMath, MathBlock } from './MathFormula.js'
import { useTranslate } from '../../i18n/index.js'
import { copyText } from '../../utils/clipboard.js'
import { IconCopyOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'

const Html = memo(function Html({ value }: { value: string }) {
  if (/^<br\s*\/?>$/i.test(value)) {
    return <br />
  }
  return <span className="ds-markdown-html">{value}</span>
})

const List = memo(function List({ node, loading }: { node: ListNode; loading: boolean }) {
  const ListTag = node.ordered ? 'ol' : 'ul'
  return (
    <ListTag start={node.ordered ? node.start || undefined : undefined}>
      {node.children.map((child, index) => {
        // GFM: task item 的 checked 为 boolean；普通 listItem 为 null
        const checked = child.checked
        const isTaskItem = typeof checked === 'boolean'
        return (
          <li key={index} className={isTaskItem ? 'ds-markdown-task-list-item' : undefined}>
            {isTaskItem ? (
              // □ U+25A1 / ☑ U+2611
              <span className="ds-markdown-task-checkbox">{checked ? '☑  ' : '□  '}</span>
            ) : null}
            <MarkdownBlockContentOrDefinitionContent nodes={child.children} loading={loading} />
          </li>
        )
      })}
    </ListTag>
  )
})

/** 表格复制用的纯文本：保留文字、行内代码与公式，去掉样式 */
const phrasingText = (nodes: PhrasingContent[]): string =>
  nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
        case 'inlineCode':
        case 'inlineMath':
          return node.value
        case 'emphasis':
        case 'strong':
        case 'link':
          return phrasingText(node.children)
        case 'image':
          return node.alt ?? ''
        case 'break':
          return ' '
        default:
          return ''
      }
    })
    .join('')

type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

/** GitHub 风格提示块：> [!NOTE] 开头 */
const readAlert = (node: BlockquoteNode): {
  kind: AlertKind
  children: Array<BlockContent | DefinitionContent>
} | null => {
  const first = node.children[0]
  if (!first || first.type !== 'paragraph') {
    return null
  }
  const firstChild = first.children[0]
  if (!firstChild || firstChild.type !== 'text') {
    return null
  }
  const match = firstChild.value.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i)
  if (!match) {
    return null
  }
  const kind = match[1].toLowerCase() as AlertKind
  const restText = firstChild.value.slice(match[0].length)
  const paragraph: Paragraph = {
    ...first,
    children: restText
      ? [{ ...firstChild, value: restText }, ...first.children.slice(1)]
      : first.children.slice(1),
  }
  return {
    kind,
    children: paragraph.children.length > 0 ? [paragraph, ...node.children.slice(1)] : node.children.slice(1),
  }
}

const ALERT_TITLE: Record<AlertKind, 'alertNote' | 'alertTip' | 'alertImportant' | 'alertWarning' | 'alertCaution'> = {
  note: 'alertNote',
  tip: 'alertTip',
  important: 'alertImportant',
  warning: 'alertWarning',
  caution: 'alertCaution',
}

/** 引用块：识别 GitHub 提示块，普通引用保持原样 */
const Blockquote = memo(function Blockquote({
  node,
  loading,
}: {
  node: BlockquoteNode
  loading: boolean
}) {
  const t = useTranslate()
  const alert = readAlert(node)
  if (alert) {
    return (
      <div className={`markdown-alert markdown-alert-${alert.kind}`}>
        <div className="markdown-alert-title">{t(ALERT_TITLE[alert.kind])}</div>
        <MarkdownBlockContentOrDefinitionContent nodes={alert.children} loading={loading} />
      </div>
    )
  }
  return (
    <blockquote>
      <MarkdownBlockContentOrDefinitionContent nodes={node.children} loading={loading} />
    </blockquote>
  )
})

const Table = memo(function Table({ node }: { node: TableNode }) {
  const t = useTranslate()
  const columnCount = node.children[0]?.children.length
  const copy = async () => {
    const rows = node.children.map((row) =>
      row.children.map((cell) => phrasingText(cell.children).replace(/\s+/g, ' ').trim())
    )
    const tsv = rows.map((row) => row.join('\t')).join('\n')
    showToast({ key: (await copyText(tsv)) ? 'copied' : 'copyFailed' })
  }
  return (
    <div className="markdown-table-wrapper">
      <button
        type="button"
        className="markdown-table-copy"
        aria-label={t('copyTable')}
        title={t('copyTable')}
        onClick={() => void copy()}
      >
        <IconCopyOutline16 />
      </button>
      <table>
        {node.children[0] ? (
          <thead>
            <tr>
              {node.children[0].children.map((cell, cellIndex) => {
                const align = node.align?.[cellIndex]
                return (
                  <th key={cellIndex} scope="col" style={align ? { textAlign: align } : undefined}>
                    <MarkdownPhrasingContent nodes={cell.children} />
                  </th>
                )
              })}
            </tr>
          </thead>
        ) : null}
        {node.children[1] ? (
          <tbody>
            {node.children.slice(1).map((row, rowIndex) => {
              const curColumnCount = row.children.length || 0
              return (
                <tr key={rowIndex}>
                  {row.children.map((cell, cellIndex) => {
                    const align = node.align?.[cellIndex]
                    return (
                      <td key={cellIndex} style={align ? { textAlign: align } : undefined}>
                        <MarkdownPhrasingContent nodes={cell.children} />
                      </td>
                    )
                  })}
                  {/* 补齐到列数 */}
                  {Array.from({ length: columnCount - curColumnCount }).map((_, idx) => (
                    <td key={`ptd_${idx}`} />
                  ))}
                </tr>
              )
            })}
          </tbody>
        ) : null}
      </table>
    </div>
  )
})

const MarkdownPhrasingContent = memo(function MarkdownPhrasingContent({
  nodes,
}: {
  nodes: PhrasingContent[]
}) {
  return (
    <>
      {nodes.map((node, index) => {
        return <MarkdownPhrasingContentItem key={index} node={node} />
      })}
    </>
  )
})

const MarkdownPhrasingContentItem = memo(function MarkdownPhrasingContentItem({
  node,
}: {
  node: PhrasingContent
}) {
  switch (node.type) {
    case 'inlineMath':
      return <InlineMath value={node.value} />
    case 'break':
      return <br />
    case 'emphasis':
      return (
        <em>
          <MarkdownPhrasingContent nodes={node.children} />
        </em>
      )
    case 'image':
      return <ImageAsLink node={node} />
    case 'html':
      return <Html value={node.value} />
    case 'inlineCode':
      return <code>{node.value}</code>
    case 'link':
      return (
        <Link node={node}>
          <MarkdownPhrasingContent nodes={node.children} />
        </Link>
      )
    case 'strong':
      return (
        <strong>
          <MarkdownPhrasingContent nodes={node.children} />
        </strong>
      )
    case 'text':
      return <TextContent>{node.value}</TextContent>
    case 'citation':
      return <CitationLink source={node.source} />
    default:
      // 删除线、脚注、引用式链接已在解析时换成文本
      return null
  }
})

// 按 \n 拆行插 <br>：源文每个换行（含软换行）都渲染为视觉换行
const TextContent = memo(function TextContent({ children }: { children: string }) {
  const result: ReactNode[] = []
  children.split(/\r?\n/).forEach((line, index) => {
    result.push(<span key={index + 's'}>{line}</span>, <br key={index + 'br'} />)
  })
  result.pop()
  return result
})

const MarkdownBlockContentOrDefinitionContent = memo(
  function MarkdownBlockContentOrDefinitionContent({
    nodes,
    loading,
  }: {
    nodes: Array<BlockContent | DefinitionContent>
    loading: boolean
  }) {
    return nodes.map((node, index) => {
      switch (node.type) {
        case 'math':
          return <MathBlock key={index} value={node.value} />
        case 'thematicBreak':
          return <hr key={index} />
        case 'blockquote':
          return <Blockquote key={index} node={node} loading={loading} />
        case 'html':
          return <Html key={index} value={node.value} />
        case 'heading':
          return node.children.length === 0
            ? null
            : createElement(
                `h${node.depth}`,
                { key: index },
                <MarkdownPhrasingContent nodes={node.children} />
              )
        case 'paragraph':
          return (
            <p key={index} className="ds-markdown-paragraph">
              <MarkdownPhrasingContent nodes={node.children} />
            </p>
          )
        case 'code':
          return (
            <CodeBlock
              key={index}
              code={node.value}
              infostring={node.lang || 'text'}
              meta={node.meta ?? ''}
              loading={loading}
            />
          )
        case 'table':
          return <Table node={node} key={index} />
        case 'list':
          return <List key={index} node={node} loading={loading} />
        default:
          // 脚注与定义已在解析时换成段落
          return null
      }
    })
  }
)

export const MarkdownAstRenderer = memo(function MarkdownAstRenderer({
  ast,
  onUpdate,
  className,
  loading = false,
}: {
  ast: Root
  className?: string
  loading?: boolean
  /**
   * layoutEffect 之后触发 -> 进行页面滚动
   */
  onUpdate: () => void
}) {
  const onUpdateRef = useRef<() => void>(() => 0)
  onUpdateRef.current = onUpdate
  useLayoutEffect(() => {
    onUpdateRef.current()
  }, [ast.children])

  return useMemo(
    () => (
      <div className={clsx('ds-markdown', className)}>
        {/* 解析器在根节点下产出块级内容。 */}
        <MarkdownBlockContentOrDefinitionContent
          nodes={ast.children as Array<BlockContent | DefinitionContent>}
          loading={loading}
        />
      </div>
    ),
    [className, ast.children, loading]
  )
})
