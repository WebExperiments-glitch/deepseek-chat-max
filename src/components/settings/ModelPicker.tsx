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
import { pushRecent, toggleFavorite, useModelPrefs } from '../../services/modelPrefs.js'
import { setProviderModel, useSettings } from '../../services/settings.js'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import styles from './ModelPicker.module.css'

type PriceFilter = 'any' | 'free' | 'under1' | 'under5' | 'over5'
type ContextFilter = 'any' | 'under128k' | '1m' | 'over1m'

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

/** 设置页里的专门「模型」分组：电商式选型器 */
export const ModelPicker = () => {
  const t = useTranslate()
  const provider = useSettings((state) => state.provider)
  const savedModel = useSettings((state) => state.models[provider])
  const catalog = useModelCatalog((state) => state.models)
  const loading = useModelCatalog((state) => state.loading)
  const favorites = useModelPrefs((state) => state.favorite)
  const recent = useModelPrefs((state) => state.recent)

  const [text, setText] = useState('')
  const [price, setPrice] = useState<PriceFilter>('any')
  const [context, setContext] = useState<ContextFilter>('any')
  const [textOnly, setTextOnly] = useState(false)
  const [video, setVideo] = useState(false)
  const [reasoning, setReasoning] = useState(false)
  const [tools, setTools] = useState(false)
  const [sort, setSort] = useState<SortKey>('default')
  const [compareIds, setCompareIds] = useState<string[]>([])

  useEffect(() => {
    void loadModelCatalog()
  }, [])

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

  // 候选池：有筛选条件时从全目录筛；否则把收藏/最近置顶展示
  const matched = useMemo(() => {
    const hasFilter =
      !!text.trim() || price !== 'any' || context !== 'any' || textOnly || video ||
      reasoning || tools
    const pool = hasFilter ? catalog : pinFavorites(catalog, favorites, recent)
    return sortModels(filterModels(pool, filter), sort)
  }, [catalog, favorites, recent, filter, sort, text, price, context, textOnly, video, reasoning, tools])
  const results = matched.slice(0, 200)
  const total = matched.length

  const compared = useMemo(
    () => compareModels(catalog, compareIds),
    [catalog, compareIds]
  )

  const choose = (model: CatalogModel) => {
    setProviderModel(provider, model.modelId)
    pushRecent(model.id)
    if (model.providerId !== provider) {
      // 模型来自别的服务商：id 可能对当前服务商无效，明确提示用户切换
      showToast(`${model.name}（${model.providerName}）· 请切换到对应服务商后使用`)
    } else {
      showToast(t('modelPickerSelected') + ': ' + model.name)
    }
  }

  const toggleCompare = (id: string) => {
    setCompareIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= 4 ? ids : [...ids, id]
    )
  }

  const label = (key: TranslationKey, fallback: string) => {
    const value = t(key)
    return value === key ? fallback : value
  }

  return (
    <div className={styles.root}>
      <div className={styles.intro}>{label('modelPickerIntro', '从上万个模型中筛选，挑一个最适合你的。')}</div>

      <input
        className={styles.search}
        placeholder={label('modelPickerSearchPlaceholder', '搜索模型名称、ID 或服务商')}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className={styles.facets}>
        <Facet label={label('modelPickerPrice', '输入价格')}>
          <Chip active={price === 'any'} onClick={() => setPrice('any')}>{label('modelPickerPriceAny', '不限')}</Chip>
          <Chip active={price === 'free'} onClick={() => setPrice('free')}>{label('modelPickerPriceFree', '免费')}</Chip>
          <Chip active={price === 'under1'} onClick={() => setPrice('under1')}>{label('modelPickerPriceUnder1', '低于 $1')}</Chip>
          <Chip active={price === 'under5'} onClick={() => setPrice('under5')}>{label('modelPickerPriceUnder5', '低于 $5')}</Chip>
          <Chip active={price === 'over5'} onClick={() => setPrice('over5')}>{label('modelPickerPriceOver5', '$5 以上')}</Chip>
        </Facet>
        <Facet label={label('modelPickerContext', '上下文窗口')}>
          <Chip active={context === 'any'} onClick={() => setContext('any')}>{label('modelPickerContextAny', '不限')}</Chip>
          <Chip active={context === 'under128k'} onClick={() => setContext('under128k')}>{label('modelPickerContext128k', '128K 以下')}</Chip>
          <Chip active={context === '1m'} onClick={() => setContext('1m')}>{label('modelPickerContext1m', '128K–1M')}</Chip>
          <Chip active={context === 'over1m'} onClick={() => setContext('over1m')}>{label('modelPickerContextBig', '1M 以上')}</Chip>
        </Facet>
        <Facet label={label('modelPickerModality', '输出模态')}>
          <Chip active={textOnly} onClick={() => setTextOnly(!textOnly)}>{label('modelPickerTextOnly', '纯文本')}</Chip>
          <Chip active={video} onClick={() => setVideo(!video)}>{label('modelPickerVideo', '视频')}</Chip>
          <Chip active={reasoning} onClick={() => setReasoning(!reasoning)}>{label('modelPickerReasoning', '支持推理')}</Chip>
          <Chip active={tools} onClick={() => setTools(!tools)}>{label('modelPickerTools', '支持工具')}</Chip>
        </Facet>
      </div>

      <div className={styles.listHead}>
        <span>{loading ? label('modelPickerLoading', '正在加载模型目录...') : label('modelPickerResultCount', '共 {count} 个模型').replace('{count}', String(total))}</span>
        <label className={styles.sort}>
          {label('modelPickerSort', '排序')}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="default">{label('modelPickerSortDefault', '默认')}</option>
            <option value="price-asc">{label('modelPickerSortPriceAsc', '价格从低到高')}</option>
            <option value="price-desc">{label('modelPickerSortPriceDesc', '价格从高到低')}</option>
            <option value="context-desc">{label('modelPickerSortContext', '上下文从大到小')}</option>
            <option value="released-desc">{label('modelPickerSortReleased', '最新发布')}</option>
            <option value="name-asc">{label('modelPickerSortName', '名称')}</option>
          </select>
        </label>
      </div>

      <div className={styles.list}>
        {results.map((m) => (
          <ModelCard
            key={m.id}
            model={m}
            active={m.modelId === savedModel && m.providerId === provider}
            favorite={favorites.includes(m.id)}
            comparing={compareIds.includes(m.id)}
            onChoose={() => choose(m)}
            onFavorite={() => toggleFavorite(m.id)}
            onCompare={() => toggleCompare(m.id)}
          />
        ))}
        {!loading && results.length === 0 ? (
          <div className={styles.empty}>{label('modelPickerEmpty', '没有符合条件的模型，试试放宽筛选')}</div>
        ) : null}
      </div>

      {compared.length > 0 ? (
        <CompareTable models={compared} onClear={() => setCompareIds([])} />
      ) : null}

      <div className={styles.note}>{label('modelPickerDataNote', '数据来自 models.dev（MIT），浏览器直连实时更新；无法获取时使用缓存。')}</div>
    </div>
  )
}

/** 把收藏/最近的模型置顶（无筛选条件时），借鉴 OpenCode 的 Favorites/Recent 分组 */
function pinFavorites(
  catalog: CatalogModel[],
  favorites: string[],
  recent: string[]
): CatalogModel[] {
  const byId = new Map(catalog.map((m) => [m.id, m]))
  const pinned = [...new Set([...favorites, ...recent])]
    .map((id) => byId.get(id))
    .filter((m): m is CatalogModel => !!m)
  const rest = catalog.filter((m) => !pinned.includes(m))
  return [...pinned, ...rest]
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

function ModelCard({
  model,
  active,
  favorite,
  comparing,
  onChoose,
  onFavorite,
  onCompare,
}: {
  model: CatalogModel
  active: boolean
  favorite: boolean
  comparing: boolean
  onChoose: () => void
  onFavorite: () => void
  onCompare: () => void
}) {
  const t = useTranslate()
  const label = (key: TranslationKey, fallback: string) => {
    const value = t(key)
    return value === key ? fallback : value
  }
  const free = isFree(model)
  return (
    <div className={active ? styles.cardActive : styles.card}>
      <div className={styles.cardTop}>
        <div className={styles.cardName} title={model.id}>
          {model.name}
          {free ? <span className={styles.freeBadge}>{label('modelPickerFreeBadge', '免费')}</span> : null}
        </div>
        <div className={styles.cardProvider}>{model.providerName}</div>
      </div>
      <div className={styles.cardMeta}>
        <span title={label('modelPickerPriceColumn', '价格')}>
          {fmtPrice(model.cost?.input)} / {fmtPrice(model.cost?.output)}
        </span>
        <span title={label('modelPickerContextColumn', '上下文')}>{fmtContext(model.contextWindow)}</span>
        <span className={styles.modalities}>
          {model.outputModalities.map((m) => (
            <span key={m} className={styles.modality}>{modalityShort(m)}</span>
          ))}
        </span>
        {model.capabilities.reasoning ? <span className={styles.cap}>推理</span> : null}
        {model.capabilities.tools ? <span className={styles.cap}>工具</span> : null}
      </div>
      <div className={styles.cardActions}>
        <button type="button" className={styles.choose} onClick={onChoose}>
          {active ? label('modelPickerSelected', '当前使用') : label('modelPickerSelect', '选用')}
        </button>
        <button type="button" className={styles.iconBtn} onClick={onFavorite} title={favorite ? label('modelPickerUnfavorite', '取消收藏') : label('modelPickerFavorite', '收藏')}>
          {favorite ? '★' : '☆'}
        </button>
        <button type="button" className={comparing ? styles.iconBtnActive : styles.iconBtn} onClick={onCompare}>
          {label('modelPickerCompare', '对比')}
        </button>
      </div>
    </div>
  )
}

function CompareTable({ models, onClear }: { models: CatalogModel[]; onClear: () => void }) {
  const t = useTranslate()
  const label = (key: TranslationKey, fallback: string) => {
    const value = t(key)
    return value === key ? fallback : value
  }
  const rows = [
    { label: label('modelPickerPriceColumn', '价格（输入/输出）'), values: models.map((m) => `${fmtPrice(m.cost?.input)} / ${fmtPrice(m.cost?.output)}`) },
    { label: label('modelPickerContextColumn', '上下文'), values: models.map((m) => fmtContext(m.contextWindow)) },
    { label: label('modelPickerModalColumn', '输出模态'), values: models.map((m) => m.outputModalities.map(modalityShort).join(' ')) },
    { label: label('modelPickerCapColumn', '能力'), values: models.map((m) => [m.capabilities.reasoning ? '推理' : '', m.capabilities.tools ? '工具' : ''].filter(Boolean).join(' ') || '—') },
  ]
  return (
    <div className={styles.compare}>
      <div className={styles.compareHead}>
        <span>{label('modelPickerCompareTitle', '模型对比')}</span>
        <button type="button" className={styles.iconBtn} onClick={onClear}>{label('modelPickerCompareClear', '清空对比')}</button>
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
