import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  TriangleAlert,
} from 'lucide-react'
import './LogsPage.css'
import { copyText } from './clipboard'

type ConversationStatus = 'success' | 'error'
type ConversationOutcome = 'answer' | 'refusal' | 'circuit_open' | 'error'
type CompletionStage = 'initial' | 'text_only_retry' | 'anchored_chat_retry' | 'none'

type ConversationLog = {
  id: string
  timestamp: string
  model: string
  requestedModel: string | null
  sessionKey: string
  anchorSourcePath: string | null
  anchorEphemeral: boolean
  compacted: boolean
  stream: boolean
  status: ConversationStatus
  statusCode: number | null
  errorMessage: string | null
  promptPreview: string
  responsePreview: string | null
  durationMs: number
  responseId: string
  promptTokens: number | null
  sourcePromptTokens: number | null
  memoryTokens: number | null
  memoryTurns: number | null
  completionTokens: number | null
  outcome: ConversationOutcome
  completionStage: CompletionStage
  refusalKind: 'image_mode' | 'generic_capability' | null
  promptFingerprint: string | null
  requestPayload: string | null
  promptBody: string | null
  responseBody: string | null
}

type Banner = {
  tone: 'error' | 'info'
  text: string
}

type FilterStatus = 'all' | ConversationStatus
type FilterOutcome = 'all' | ConversationOutcome

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  })

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(data.error?.message ?? `请求失败：${response.status}`)
  }

  return (await response.json()) as T
}

async function downloadExport(url: string, filenameFallback: string) {
  const response = await fetch(url)
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(data.error?.message ?? `导出失败：${response.status}`)
  }

  const disposition = response.headers.get('content-disposition') ?? ''
  const matched = disposition.match(/filename="?([^"]+)"?/)
  const filename = matched?.[1] ?? filenameFallback
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} 毫秒`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')} 秒`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} 分 ${seconds % 60} 秒`
}

function timeAgo(value: string): string {
  const diff = Date.now() - new Date(value).getTime()
  if (diff < 5000) return '刚刚'
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

function outcomeLabel(outcome: ConversationOutcome): string {
  if (outcome === 'answer') return '已回答'
  if (outcome === 'refusal') return '已拒答'
  if (outcome === 'circuit_open') return '冷却中'
  return '错误'
}

function completionStageLabel(stage: CompletionStage): string {
  if (stage === 'initial') return '首次请求'
  if (stage === 'text_only_retry') return '纯文本重试'
  if (stage === 'anchored_chat_retry') return '锚定会话重试'
  return '无'
}

function buildConversationUrl(params: {
  limit?: number
  query?: string
  status?: FilterStatus
  outcome?: FilterOutcome
  dateFrom?: string
  dateTo?: string
}): string {
  const search = new URLSearchParams()
  search.set('limit', String(params.limit ?? 200))
  if (params.query?.trim()) {
    search.set('query', params.query.trim())
  }
  if (params.status && params.status !== 'all') {
    search.set('status', params.status)
  }
  if (params.outcome && params.outcome !== 'all') {
    search.set('outcome', params.outcome)
  }
  if (params.dateFrom) {
    search.set('dateFrom', `${params.dateFrom}T00:00:00.000Z`)
  }
  if (params.dateTo) {
    search.set('dateTo', `${params.dateTo}T23:59:59.999Z`)
  }
  return `/admin/conversations?${search.toString()}`
}

export default function LogsPage() {
  const [conversations, setConversations] = useState<ConversationLog[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [searchText, setSearchText] = useState('')
  const deferredSearchText = useDeferredValue(searchText)
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterOutcome, setFilterOutcome] = useState<FilterOutcome>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [banner, setBanner] = useState<Banner | null>(null)
  const [detailCache, setDetailCache] = useState<Record<string, ConversationLog>>({})
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null)
  const [exportingKey, setExportingKey] = useState<string | null>(null)
  const reconnectTimer = useRef<number | null>(null)

  const clearReconnectTimer = () => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
  }

  const queryUrl = buildConversationUrl({
    limit: 200,
    query: deferredSearchText,
    status: filterStatus,
    outcome: filterOutcome,
    dateFrom,
    dateTo,
  })

  const loadConversations = useCallback(async () => {
    try {
      const data = await requestJson<ConversationLog[]>(queryUrl)
      setConversations(data)
      setBanner(null)
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : '加载会话记录失败',
      })
    } finally {
      setLoading(false)
    }
  }, [queryUrl])

  useEffect(() => {
    setLoading(true)
    void loadConversations()
  }, [loadConversations])

  useEffect(() => {
    if (!autoRefresh) {
      clearReconnectTimer()
      return
    }

    let cancelled = false
    let source: EventSource | null = null

    const connect = () => {
      if (cancelled) return

      source = new EventSource('/admin/conversations/stream')
      source.onmessage = () => {
        void loadConversations()
      }
      source.onerror = () => {
        source?.close()
        clearReconnectTimer()

        if (!cancelled) {
          reconnectTimer.current = window.setTimeout(() => {
            connect()
          }, 2500)
        }
      }
    }

    connect()

    return () => {
      cancelled = true
      source?.close()
      clearReconnectTimer()
    }
  }, [autoRefresh, loadConversations])

  useEffect(() => {
    if (!autoRefresh) return

    const interval = window.setInterval(() => {
      void loadConversations()
    }, 5000)

    return () => window.clearInterval(interval)
  }, [autoRefresh, loadConversations])

  const handleCopy = async (text: string, id: string) => {
    try {
      const copied = await copyText(text)
      if (!copied) {
        throw new Error('复制失败')
      }
      setCopiedId(id)
      window.setTimeout(() => setCopiedId(null), 1800)
    } catch {
      setBanner({ tone: 'info', text: '复制失败，请手动复制文本。' })
    }
  }

  const ensureDetail = useCallback(
    async (id: string) => {
      if (detailCache[id]) {
        return detailCache[id]
      }

      setDetailLoadingId(id)
      try {
        const detail = await requestJson<ConversationLog>(`/admin/conversations/${id}`)
        setDetailCache((current) => ({ ...current, [id]: detail }))
        return detail
      } finally {
        setDetailLoadingId((current) => (current === id ? null : current))
      }
    },
    [detailCache],
  )

  const handleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null)
      return
    }

    setExpandedId(id)
    try {
      await ensureDetail(id)
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : '加载详情失败',
      })
    }
  }

  const handleExport = async (preset: 'current' | 'recent_failures') => {
    const search = new URLSearchParams()
    search.set('format', 'jsonl')

    if (preset === 'recent_failures') {
      search.set('preset', 'recent_failures')
      search.set('limit', '200')
    } else {
      search.set('limit', '500')
      if (deferredSearchText.trim()) {
        search.set('query', deferredSearchText.trim())
      }
      if (filterStatus !== 'all') {
        search.set('status', filterStatus)
      }
      if (filterOutcome !== 'all') {
        search.set('outcome', filterOutcome)
      }
      if (dateFrom) {
        search.set('dateFrom', `${dateFrom}T00:00:00.000Z`)
      }
      if (dateTo) {
        search.set('dateTo', `${dateTo}T23:59:59.999Z`)
      }
    }

    setExportingKey(preset)
    try {
      await downloadExport(
        `/admin/conversations/export?${search.toString()}`,
        preset === 'recent_failures' ? '近期失败记录.jsonl' : '会话记录.jsonl',
      )
      setBanner({
        tone: 'info',
        text: preset === 'recent_failures' ? '近期失败记录已导出。' : '当前结果已导出。',
      })
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : '导出会话记录失败',
      })
    } finally {
      setExportingKey(null)
    }
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      <main className="page-shell logs-shell" id="main-content">
        <header className="logs-header">
          <div className="header-copy">
            <Link className="back-link" to="/">
              <ArrowLeft size={16} />
              返回 Gemini Bridge
            </Link>
            <h1>会话记录</h1>
            <p>先筛选，再展开需要查看的记录。这样更容易找到你真正关心的内容。</p>
          </div>

          <div className="header-actions">
            <button className="soft-button" onClick={() => void loadConversations()} type="button">
              <RefreshCw size={16} />
              刷新
            </button>

            <button
              className="soft-button"
              disabled={exportingKey !== null}
              onClick={() => void handleExport('current')}
              type="button"
            >
              {exportingKey === 'current' ? <Loader2 className="spin" size={14} /> : <ArrowDownToLine size={14} />}
              导出当前结果
            </button>
          </div>
        </header>

        {banner ? (
          <div
            aria-live="polite"
            className={`banner ${banner.tone}`}
            role={banner.tone === 'error' ? 'alert' : 'status'}
          >
            {banner.text}
          </div>
        ) : null}

        <section className="filters-panel">
          <div className="search-box">
            <label className="sr-only" htmlFor="conversation-search">
              搜索会话记录
            </label>
            <Search size={15} />
            <input
              id="conversation-search"
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="搜索提问、回答、模型或记录 ID"
              spellCheck={false}
              type="text"
              value={searchText}
            />
          </div>

          <div aria-label="状态筛选" className="filter-pills" role="group">
            <button className={`pill ${filterStatus === 'all' ? 'active' : ''}`} onClick={() => setFilterStatus('all')} type="button">
              全部
            </button>
            <button
              className={`pill ${filterStatus === 'success' ? 'active' : ''}`}
              onClick={() => setFilterStatus('success')}
              type="button"
            >
              成功
            </button>
            <button className={`pill ${filterStatus === 'error' ? 'active' : ''}`} onClick={() => setFilterStatus('error')} type="button">
              错误
            </button>
          </div>

          <div className="filter-inline">
            <label className="filter-select">
              <span>结果类型</span>
              <select value={filterOutcome} onChange={(event) => setFilterOutcome(event.target.value as FilterOutcome)}>
                <option value="all">全部</option>
                <option value="answer">已回答</option>
                <option value="refusal">已拒答</option>
                <option value="circuit_open">冷却中</option>
                <option value="error">错误</option>
              </select>
            </label>

            <label className="filter-date">
              <span>开始日期</span>
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            </label>

            <label className="filter-date">
              <span>结束日期</span>
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            </label>

            <label className="toggle-auto">
              <input checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} type="checkbox" />
              自动刷新
            </label>
          </div>

          <details className="more-actions">
            <summary>更多操作</summary>
            <button
              className="soft-button"
              disabled={exportingKey !== null}
              onClick={() => void handleExport('recent_failures')}
              type="button"
            >
              {exportingKey === 'recent_failures' ? <Loader2 className="spin" size={14} /> : <TriangleAlert size={14} />}
              导出失败记录
            </button>
          </details>
        </section>

        <section className="conv-list">
          {loading && conversations.length === 0 ? (
            <div className="empty-state">
              <Loader2 className="spin" size={36} />
              <p>正在加载会话记录...</p>
            </div>
          ) : conversations.length === 0 ? (
            <div className="empty-state">
              <FileText size={40} strokeWidth={1.3} />
              <p>没有匹配的记录</p>
              <p className="subtle">可以先清空筛选条件，再重新查看。</p>
            </div>
          ) : (
            conversations.map((conversation) => {
              const isExpanded = expandedId === conversation.id
              const detail = detailCache[conversation.id] ?? conversation
              const isDetailLoading = detailLoadingId === conversation.id
              const promptText = detail.promptBody ?? detail.promptPreview
              const responseText = detail.responseBody ?? detail.responsePreview
              const requestPayload = detail.requestPayload

              return (
                <article className={`conv-card ${isExpanded ? 'expanded' : ''}`} key={conversation.id}>
                  <button
                    aria-controls={`conv-detail-${conversation.id}`}
                    aria-expanded={isExpanded}
                    className="conv-header"
                    onClick={() => void handleExpand(conversation.id)}
                    type="button"
                  >
                    <div className="conv-status-icon">
                      {conversation.status === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                    </div>

                    <div className="conv-main">
                      <div className="conv-meta">
                        <code className="conv-model">{conversation.model}</code>
                        <span className={`badge ${conversation.stream ? 'stream' : 'sync'}`}>
                          {conversation.stream ? '流式' : '同步'}
                        </span>
                        <span className={`badge outcome ${conversation.outcome}`}>{outcomeLabel(conversation.outcome)}</span>
                        <span className="conv-time" title={formatDate(conversation.timestamp)}>
                          {timeAgo(conversation.timestamp)}
                        </span>
                      </div>
                      <p className="conv-preview">{conversation.promptPreview}</p>
                    </div>

                    <div className="conv-side">
                      <span className="duration">{formatDuration(conversation.durationMs)}</span>
                      {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                    </div>
                  </button>

                  {isExpanded ? (
                    <div className="conv-detail" id={`conv-detail-${conversation.id}`}>
                      {isDetailLoading ? (
                        <div className="detail-loading">
                          <Loader2 className="spin" size={16} />
                          正在加载完整内容...
                        </div>
                      ) : null}

                      {conversation.status === 'error' && conversation.errorMessage ? (
                        <div className="error-box">
                          错误信息：{conversation.errorMessage}
                          {conversation.statusCode ? `（HTTP ${conversation.statusCode}）` : ''}
                        </div>
                      ) : null}

                      {requestPayload ? (
                        <div className="detail-section">
                          <div className="detail-head">
                            <h3>原始请求</h3>
                            <button
                              className={`copy-btn ${copiedId === `req-${conversation.id}` ? 'copied' : ''}`}
                              onClick={() => void handleCopy(requestPayload, `req-${conversation.id}`)}
                              type="button"
                            >
                              {copiedId === `req-${conversation.id}` ? <Check size={13} /> : <Copy size={13} />}
                            </button>
                          </div>
                          <pre className="detail-pre">{requestPayload}</pre>
                        </div>
                      ) : null}

                      <div className="detail-section">
                        <div className="detail-head">
                          <h3>提示词</h3>
                          <button
                            className={`copy-btn ${copiedId === `prompt-${conversation.id}` ? 'copied' : ''}`}
                            onClick={() => void handleCopy(promptText, `prompt-${conversation.id}`)}
                            type="button"
                          >
                            {copiedId === `prompt-${conversation.id}` ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        </div>
                        <pre className="detail-pre">{promptText}</pre>
                      </div>

                      {responseText ? (
                        <div className="detail-section">
                          <div className="detail-head">
                            <h3>响应</h3>
                            <button
                              className={`copy-btn ${copiedId === `resp-${conversation.id}` ? 'copied' : ''}`}
                              onClick={() => void handleCopy(responseText, `resp-${conversation.id}`)}
                              type="button"
                            >
                              {copiedId === `resp-${conversation.id}` ? <Check size={13} /> : <Copy size={13} />}
                            </button>
                          </div>
                          <pre className="detail-pre">{responseText}</pre>
                        </div>
                      ) : null}

                      <details className="more-meta">
                        <summary>更多信息</summary>
                        <div className="meta-grid">
                          <div>
                            <span>记录 ID</span>
                            <strong>{conversation.id}</strong>
                          </div>
                          <div>
                            <span>时间</span>
                            <strong>{formatDate(conversation.timestamp)}</strong>
                          </div>
                          <div>
                            <span>结果</span>
                            <strong>{outcomeLabel(conversation.outcome)}</strong>
                          </div>
                          <div>
                            <span>模式</span>
                            <strong>{conversation.stream ? '流式返回' : '同步返回'}</strong>
                          </div>
                          <div>
                            <span>阶段</span>
                            <strong>{completionStageLabel(conversation.completionStage)}</strong>
                          </div>
                          <div>
                            <span>状态码</span>
                            <strong>{conversation.statusCode ?? '正常'}</strong>
                          </div>
                        </div>
                      </details>
                    </div>
                  ) : null}
                </article>
              )
            })
          )}
        </section>
      </main>
    </>
  )
}
