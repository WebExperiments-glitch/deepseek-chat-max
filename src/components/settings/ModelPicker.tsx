import { useEffect, useMemo, useState } from 'react'
import { loadModelCatalog, useModelCatalog, type CatalogModel } from '../../services/modelCatalog.js'
import {
  compareModels,
  isFree,
  type ModelFilter,
  type SortKey,
  filterModels,
  sortModels,
} from '../../services/modelPicker.js'
import { groupByProvider, latestPerFamily, pinSections, type ModelGroup } from '../../services/modelGroups.js'
import { pushRecent, toggleFavorite, useModelPrefs } from '../../services/modelPrefs.js'
import { setProvider, setProviderModel, useSettings } from '../../services/settings.js'
import { useModels } from '../../services/models.js'
import { isProviderId } from '../../services/api/providers.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import { Tooltip } from '../base/Tooltip.js'
import styles from './ModelPicker.module.css'

type PriceFilter = 'any' | 'free' | 'under1' | 'under5' | 'over5'
type ContextFilter = 'any' | 'under128k' | '1m' | 'over1m'
type ViewMode = 'grouped' | 'grid'

const PRICE_RANGES: Record<Exclude<PriceFilter, 'any' | 'free'>, [number, number]> = {
  under1: [0, 1],
  under5: [0, 5],
  over5: [5, Number.MAX_SAFE_INTEGER],
}
const CONTEXT_RANGES: Record<Exclude<ContextFilter, 'any'>, [number, number]> = {
  under128k: [0, 128 * 1024],
  '1m': [128 * 1024, 1024 * 1024],
  over1m: [1024 * 1024, Number.MAX_SAFE_INTEGER],
}

const fmtPrice = (v: number | undefined): string =>
  v === undefined ? '—' : v === 0 ? '0' : `$${v}`
const fmtContext = (v: number | undefined): string =>
  v === undefined ? '—' : v >= 1024 * 1024 ? `${(v / 1024 / 1024).toFixed(1)}M` : `${Math.round(v / 1024)}K`
const modalityShort = (m: string): string =>
  ({ text: '文', image: '图', audio: '音', video: '视', pdf: 'PDF' })[m] ?? m

const tr = (t: (k: TranslationKey) => string, key: TranslationKey, fallback: string): string => {
  const value = t(key)
  return value === key ? fallback : value
}

/** 设置页里的专门「模型」分组：电商式选型 + OpenCode/DSH 分组选择交互 */
export const ModelPicker = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const savedModel = useSettings((state) => state.models[provider])
  const catalog = useModelCatalog((state) => state.models)
  const loading = useModelCatalog((state) => state.loading)
  const favorites = useModelPrefs((state) => state.favorite)
  const recent = useModelPrefs((state) => state.recent)

  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [text, setText] = useState('')
  const [price, setPrice] = useState<PriceFilter>('any')
  const [context, setContext] = useState<ContextFilter>('any')
  const [textOnly, setTextOnly] = useState(false)
  const [video, setVideo] = useState(false)
  const [reasoning, setReasoning] = useState(false)
  const [tools, setTools] = useState(false)
  const [sort, setSort] = useState<SortKey>('default')
  const [view, setView] = useState<ViewMode>('grouped')
  const [latestOnly, setLatestOnly] = useState(true)
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [focusId, setFocusId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    void loadModelCatalog()
  }, [])

  // 「我的模型」= 当前 Key 真实可用的清单（/models 或一键检测的结果），不是 4380 全量目录
  const mineModels = useModels((state) => state.lists[provider])
  const mineLoading = useModels((state) => state.loading[provider])

  const filter = useMemo<ModelFilter>(() => {
    const f: ModelFilter = { text }
    if (price === 'free') {
      f.free = true
    } else if (price !== 'any') {
      f.price = PRICE_RANGES[price]
    }
    if (context !== 'any') {
      f.context = CONTEXT_RANGES[context]
    }
    if (textOnly) {
      f.textOnly = true
    }
    if (video) {
      f.modalities = ['video']
    }
    if (reasoning) {
      f.reasoning = true
    }
    if (tools) {
      f.tools = true
    }
    return f
  }, [text, price, context, textOnly, video, reasoning, tools])

  const hasFilter =
    !!text.trim() || price !== 'any' || context !== 'any' || textOnly || video ||
    reasoning || tools

  const matched = useMemo(() => {
    let pool = hasFilter ? catalog : catalog
    if (latestOnly && !hasFilter) {
      pool = latestPerFamily(pool)
    }
    return sortModels(filterModels(pool, filter), sort)
  }, [catalog, filter, sort, hasFilter, latestOnly])

  const total = matched.length
  const shown = matched.slice(0, 300)

  const compared = useMemo(() => compareModels(catalog, compareIds), [catalog, compareIds])

  // 分组视图：收藏 / 最近置顶（仅无筛选时），其余按服务商分组；搜索时展平
  const sections = useMemo(() => {
    if (view !== 'grouped' || hasFilter) {
      return []
    }
    return pinSections(shown, favorites, recent)
  }, [view, hasFilter, shown, favorites, recent])

  const groups = useMemo<ModelGroup[]>(() => {
    if (view !== 'grouped') {
      return []
    }
    const pinnedIds = new Set(sections.flatMap((s) => s.models.map((m) => m.id)))
    const rest = hasFilter ? shown : shown.filter((m) => !pinnedIds.has(m.id))
    return groupByProvider(rest)
  }, [view, hasFilter, shown, sections])

  // 抄 OpenCode：选择模型时同时切换服务商（model.set({modelID, providerID}, {recent:true})）
  const choose = (model: CatalogModel) => {
    pushRecent(model.id)
    if (isProviderId(model.providerId) && model.providerId !== provider) {
      setProvider(model.providerId)
    }
    setProviderModel(model.providerId, model.modelId)
    showToast(tr(t, 'modelPickerSelected', '当前使用') + ': ' + model.name)
  }

  const toggleCompare = (id: string) => {
    setCompareIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= 4 ? ids : [...ids, id]
    )
  }

  // Mod+F 收藏当前聚焦（最后点选）的模型，抄 OpenCode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f' && focusId) {
        e.preventDefault()
        toggleFavorite(focusId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusId])

  const toggleGroup = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const rowProps = (m: CatalogModel) => ({
    model: m,
    active: m.modelId === savedModel && m.providerId === provider,
    favorite: favorites.includes(m.id),
    comparing: compareIds.includes(m.id),
    onChoose: () => {
      setFocusId(m.id)
      choose(m)
    },
    onFavorite: () => toggleFavorite(m.id),
    onCompare: () => toggleCompare(m.id),
  })

  // 数据源切换：默认只显示当前 Key 真正能用的模型；「全部目录」才是 4380 的探索视图
  const scopeTab = (
    <div className={styles.scopeTabs}>
      <button
        type="button"
        className={scope === 'mine' ? styles.scopeBtnActive : styles.scopeBtn}
        onClick={() => setScope('mine')}
      >
        {tr(t, 'modelPickerScopeMine', '我的可用模型')}
        {mineModels.length > 0 ? ` (${mineModels.length})` : ''}
      </button>
      <button
        type="button"
        className={scope === 'all' ? styles.scopeBtnActive : styles.scopeBtn}
        onClick={() => setScope('all')}
      >
        {tr(t, 'modelPickerScopeAll', '全部目录')}
      </button>
    </div>
  )

  if (scope === 'mine') {
    return (
      <div className={styles.root}>
        {scopeTab}
        <div className={styles.intro}>{tr(t, 'modelPickerMineIntro', '这里只显示当前密钥真正能用的模型。填入 API Key 后会自动检测；也可以到设置里点「检测可用模型」。')}</div>
        {mineLoading ? (
          <div className={styles.description}>{tr(t, 'modelPickerMineLoading', '正在读取模型清单…')}</div>
        ) : mineModels.length === 0 ? (
          <div className={styles.description}>{tr(t, 'modelPickerMineEmpty', '还没有检测到可用模型。请先在「数据管理」里填好 API Key，再点「检测可用模型」。')}</div>
        ) : (
          <div className={styles.list}>
            {mineModels.map((model) => {
              const active = model.id === savedModel
              return (
                <div key={model.id} className={styles.mineRow}>
                  <div className={styles.mineInfo}>
                    <span className={styles.mineName}>{model.label}</span>
                    <span className={styles.mineId}>{model.id}</span>
                    {model.contextWindow ? (
                      <span className={styles.modality}>{fmtContext(model.contextWindow)}</span>
                    ) : null}
                  </div>
                  <div className={styles.mineActions}>
                    <button type="button" className={styles.iconBtn} onClick={() => toggleFavorite(model.id)}>
                      {favorites.includes(model.id) ? '★' : '☆'}
                    </button>
                    <button
                      type="button"
                      className={active ? styles.chooseActive : styles.choose}
                      disabled={active}
                      onClick={() => {
                        pushRecent(model.id)
                        setProviderModel(provider, model.id)
                        showToast(tr(t, 'modelPickerSelected', '当前使用') + ': ' + model.label)
                      }}
                    >
                      {active ? tr(t, 'modelPickerSelected', '当前使用') : tr(t, 'modelPickerSelect', '选用')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.root}>
      {scopeTab}
      <div className={styles.intro}>{tr(t, 'modelPickerIntro', '从上万个模型中按价格、上下文、能力筛选，挑一个最适合你的。数据来自公开模型库，每天更新。')}</div>

      <div className={styles.searchRow}>
        <input
          className={styles.search}
          placeholder={tr(t, 'modelPickerSearchPlaceholder', '搜索模型名称、ID 或服务商')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className={styles.viewToggle}>
          <button type="button" className={view === 'grouped' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setView('grouped')}>
            {tr(t, 'modelPickerViewGrouped', '分组')}
          </button>
          <button type="button" className={view === 'grid' ? styles.viewBtnActive : styles.viewBtn} onClick={() => setView('grid')}>
            {tr(t, 'modelPickerViewGrid', '卡片')}
          </button>
        </div>
      </div>

      <div className={styles.facets}>
        <Facet label={tr(t, 'modelPickerPrice', '输入价格')}>
          <Chip active={price === 'any'} onClick={() => setPrice('any')}>{tr(t, 'modelPickerPriceAny', '不限')}</Chip>
          <Chip active={price === 'free'} onClick={() => setPrice('free')}>{tr(t, 'modelPickerPriceFree', '免费')}</Chip>
          <Chip active={price === 'under1'} onClick={() => setPrice('under1')}>{tr(t, 'modelPickerPriceUnder1', '低于 $1')}</Chip>
          <Chip active={price === 'under5'} onClick={() => setPrice('under5')}>{tr(t, 'modelPickerPriceUnder5', '低于 $5')}</Chip>
          <Chip active={price === 'over5'} onClick={() => setPrice('over5')}>{tr(t, 'modelPickerPriceOver5', '$5 以上')}</Chip>
        </Facet>
        <Facet label={tr(t, 'modelPickerContext', '上下文窗口')}>
          <Chip active={context === 'any'} onClick={() => setContext('any')}>{tr(t, 'modelPickerContextAny', '不限')}</Chip>
          <Chip active={context === 'under128k'} onClick={() => setContext('under128k')}>{tr(t, 'modelPickerContext128k', '128K 以下')}</Chip>
          <Chip active={context === '1m'} onClick={() => setContext('1m')}>{tr(t, 'modelPickerContext1m', '128K–1M')}</Chip>
          <Chip active={context === 'over1m'} onClick={() => setContext('over1m')}>{tr(t, 'modelPickerContextBig', '1M 以上')}</Chip>
        </Facet>
        <Facet label={tr(t, 'modelPickerModality', '输出模态')}>
          <Chip active={textOnly} onClick={() => setTextOnly(!textOnly)}>{tr(t, 'modelPickerTextOnly', '纯文本')}</Chip>
          <Chip active={video} onClick={() => setVideo(!video)}>{tr(t, 'modelPickerVideo', '视频')}</Chip>
          <Chip active={reasoning} onClick={() => setReasoning(!reasoning)}>{tr(t, 'modelPickerReasoning', '支持推理')}</Chip>
          <Chip active={tools} onClick={() => setTools(!tools)}>{tr(t, 'modelPickerTools', '支持工具')}</Chip>
        </Facet>
      </div>

      <div className={styles.listHead}>
        <span>
          {loading
            ? tr(t, 'modelPickerLoading', '正在加载模型目录...')
            : tr(t, 'modelPickerResultCount', '共 {count} 个模型').replace('{count}', String(total))}
        </span>
        <div className={styles.listControls}>
          <label className={styles.latestToggle}>
            <input type="checkbox" checked={latestOnly} onChange={(e) => setLatestOnly(e.target.checked)} disabled={hasFilter} />
            {tr(t, 'modelPickerLatestOnly', '仅最新')}
          </label>
          <label className={styles.sort}>
            {tr(t, 'modelPickerSort', '排序')}
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="default">{tr(t, 'modelPickerSortDefault', '默认')}</option>
              <option value="price-asc">{tr(t, 'modelPickerSortPriceAsc', '价格从低到高')}</option>
              <option value="price-desc">{tr(t, 'modelPickerSortPriceDesc', '价格从高到低')}</option>
              <option value="context-desc">{tr(t, 'modelPickerSortContext', '上下文从大到小')}</option>
              <option value="released-desc">{tr(t, 'modelPickerSortReleased', '最新发布')}</option>
              <option value="name-asc">{tr(t, 'modelPickerSortName', '名称')}</option>
            </select>
          </label>
        </div>
      </div>

      <div className={view === 'grid' ? styles.listGrid : styles.list}>
        {view === 'grouped' ? (
          <>
            {sections.map((section) => (
              <div key={section.section} className={styles.group}>
                <div className={styles.groupTitle}>
                  {section.section === 'favorite'
                    ? tr(t, 'modelPickerFavorites', '我的收藏')
                    : tr(t, 'modelPickerRecent', '最近使用')}
                  <span className={styles.groupCount}>{section.models.length}</span>
                </div>
                {section.models.map((m) => <ModelRow key={m.id} {...rowProps(m)} />)}
              </div>
            ))}
            {groups.map((group) => (
              <div key={group.id} className={styles.group}>
                <button type="button" className={styles.groupTitle} onClick={() => toggleGroup(group.id)}>
                  <span className={collapsed.has(group.id) ? styles.chevronCollapsed : styles.chevron}>▾</span>
                  {group.name}
                  <span className={styles.groupCount}>{group.models.length}</span>
                </button>
                {!collapsed.has(group.id)
                  ? group.models.map((m) => <ModelRow key={m.id} {...rowProps(m)} />)
                  : null}
              </div>
            ))}
          </>
        ) : (
          shown.map((m) => <ModelCard key={m.id} {...rowProps(m)} />)
        )}
        {!loading && shown.length === 0 ? (
          <div className={styles.empty}>{tr(t, 'modelPickerEmpty', '没有符合条件的模型，试试放宽筛选')}</div>
        ) : null}
      </div>

      {compared.length > 0 ? (
        <CompareTable models={compared} onClear={() => setCompareIds([])} />
      ) : null}

      <div className={styles.note}>{tr(t, 'modelPickerDataNote', '数据来自 models.dev（MIT），浏览器直连实时更新；无法获取时使用缓存。')}</div>
    </div>
  )
}

function Facet({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.facet}>
      <div className={styles.facetLabel}>{label}</div>
      <div className={styles.chips}>{children}</div>
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={active ? styles.chipActive : styles.chip} onClick={onClick}>
      {children}
    </button>
  )
}

type RowProps = {
  model: CatalogModel
  active: boolean
  favorite: boolean
  comparing: boolean
  onChoose: () => void
  onFavorite: () => void
  onCompare: () => void
}

/** 模型详情 tooltip（抄 OpenCode tooltip：上下文/输入输出/模态/推理/工具） */
function ModelTooltip({ model }: { model: CatalogModel }) {
  const t = useTranslate()
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipTitle}>{model.name}</div>
      <div className={styles.tooltipId}>{model.providerId}/{model.modelId}</div>
      <div className={styles.tooltipGrid}>
        <span>{tr(t, 'modelPickerPriceColumn', '价格(入/出)')}</span>
        <span>{fmtPrice(model.cost?.input)} / {fmtPrice(model.cost?.output)}</span>
        <span>{tr(t, 'modelPickerContextColumn', '上下文')}</span>
        <span>{fmtContext(model.contextWindow)}</span>
        <span>{tr(t, 'modelPickerSortReleased', '发布')}</span>
        <span>{model.releaseDate ?? '—'}</span>
        <span>{tr(t, 'modelPickerModalColumn', '输入/输出')}</span>
        <span>{model.inputModalities.map(modalityShort).join('')} → {model.outputModalities.map(modalityShort).join('')}</span>
        <span>{tr(t, 'modelPickerCapColumn', '能力')}</span>
        <span>{[model.capabilities.reasoning ? tr(t, 'modelPickerReasoning', '推理') : '', model.capabilities.tools ? tr(t, 'modelPickerTools', '工具') : ''].filter(Boolean).join(' · ') || '—'}</span>
      </div>
    </div>
  )
}

/** 紧凑模型行（OpenCode/DSH 选择器风格） */
function ModelRow({ model, active, favorite, comparing, onChoose, onFavorite, onCompare }: RowProps) {
  const t = useTranslate()
  const free = isFree(model)
  return (
    <Tooltip content={<ModelTooltip model={model} />}>
      <div className={active ? styles.rowActive : styles.row}>
        <button type="button" className={styles.rowMain} onClick={onChoose}>
          <span className={styles.rowName}>
            {model.name}
            {free ? <span className={styles.freeBadge}>{tr(t, 'modelPickerFreeBadge', '免费')}</span> : null}
          </span>
          <span className={styles.rowMeta}>
            {fmtPrice(model.cost?.input)} · {fmtContext(model.contextWindow)}
            {model.outputModalities.map((m) => <span key={m} className={styles.modality}>{modalityShort(m)}</span>)}
          </span>
        </button>
        <button type="button" className={styles.iconBtn} onClick={onFavorite} title={favorite ? tr(t, 'modelPickerUnfavorite', '取消收藏') : tr(t, 'modelPickerFavorite', '收藏')}>
          {favorite ? '★' : '☆'}
        </button>
        <button type="button" className={comparing ? styles.iconBtnActive : styles.iconBtn} onClick={onCompare}>
          {tr(t, 'modelPickerCompare', '对比')}
        </button>
      </div>
    </Tooltip>
  )
}

/** 卡片视图（电商式，保留） */
function ModelCard({ model, active, favorite, comparing, onChoose, onFavorite, onCompare }: RowProps) {
  const t = useTranslate()
  const free = isFree(model)
  return (
    <div className={active ? styles.cardActive : styles.card}>
      <Tooltip content={<ModelTooltip model={model} />}>
        <div className={styles.cardTop}>
          <div className={styles.cardName} title={model.id}>
            {model.name}
            {free ? <span className={styles.freeBadge}>{tr(t, 'modelPickerFreeBadge', '免费')}</span> : null}
          </div>
          <div className={styles.cardProvider}>{model.providerName}</div>
        </div>
      </Tooltip>
      <div className={styles.cardMeta}>
        <span>{fmtPrice(model.cost?.input)} / {fmtPrice(model.cost?.output)}</span>
        <span>{fmtContext(model.contextWindow)}</span>
        {model.outputModalities.map((m) => <span key={m} className={styles.modality}>{modalityShort(m)}</span>)}
        {model.capabilities.reasoning ? <span className={styles.cap}>推理</span> : null}
        {model.capabilities.tools ? <span className={styles.cap}>工具</span> : null}
      </div>
      <div className={styles.cardActions}>
        <button type="button" className={styles.choose} onClick={onChoose}>
          {active ? tr(t, 'modelPickerSelected', '当前使用') : tr(t, 'modelPickerSelect', '选用')}
        </button>
        <button type="button" className={styles.iconBtn} onClick={onFavorite}>{favorite ? '★' : '☆'}</button>
        <button type="button" className={comparing ? styles.iconBtnActive : styles.iconBtn} onClick={onCompare}>
          {tr(t, 'modelPickerCompare', '对比')}
        </button>
      </div>
    </div>
  )
}

function CompareTable({ models, onClear }: { models: CatalogModel[]; onClear: () => void }) {
  const t = useTranslate()
  const rows = [
    { label: tr(t, 'modelPickerPriceColumn', '价格（输入/输出）'), values: models.map((m) => `${fmtPrice(m.cost?.input)} / ${fmtPrice(m.cost?.output)}`) },
    { label: tr(t, 'modelPickerContextColumn', '上下文'), values: models.map((m) => fmtContext(m.contextWindow)) },
    { label: tr(t, 'modelPickerModalColumn', '输出模态'), values: models.map((m) => m.outputModalities.map(modalityShort).join(' ')) },
    { label: tr(t, 'modelPickerCapColumn', '能力'), values: models.map((m) => [m.capabilities.reasoning ? tr(t, 'modelPickerReasoning', '推理') : '', m.capabilities.tools ? tr(t, 'modelPickerTools', '工具') : ''].filter(Boolean).join(' ') || '—') },
  ]
  return (
    <div className={styles.compare}>
      <div className={styles.compareHead}>
        <span>{tr(t, 'modelPickerCompareTitle', '模型对比')}</span>
        <button type="button" className={styles.iconBtn} onClick={onClear}>{tr(t, 'modelPickerCompareClear', '清空对比')}</button>
      </div>
      <div className={styles.compareGrid}>
        <div />
        {models.map((m) => <div key={m.id} className={styles.compareModelName}>{m.name}</div>)}
        {rows.map((row) => (
          <div key={row.label} className={styles.compareRow} style={{ display: 'contents' }}>
            <div className={styles.compareLabel}>{row.label}</div>
            {row.values.map((v, i) => <div key={i} className={styles.compareValue}>{v}</div>)}
          </div>
        ))}
      </div>
    </div>
  )
}
