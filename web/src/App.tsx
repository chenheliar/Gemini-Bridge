import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Copy,
  Cookie,
  FileText,
  Link2,
  Network,
  PlayCircle,
  RefreshCw,
  Save,
  Server,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react'
import './App.css'
import { copyText } from './clipboard'

type CookieInspection = {
  status: 'missing' | 'valid' | 'expiring' | 'expired'
  checkedAt: string
  expiresAt: string | null
  requiredMissing: string[]
  totalCookies: number
  expiringSoon: boolean
}

type AnchorStatus = {
  url: string | null
  sourcePath: string | null
  conversationId: string | null
  enabled: boolean
  valid: boolean
  error: string | null
}

type NetworkEndpoint = {
  kind: 'local' | 'lan'
  host: string
  url: string
}

type StatusResponse = {
  service: 'running' | 'stopped'
  uptimeMs: number
  requestCount: number
  errorCount: number
  lastRequestAt: string | null
  host: string
  port: number
  proxy: string | null
  effectiveProxy: string | null
  defaultModel: string
  anchor: AnchorStatus
  cookieInspection: CookieInspection
  localApiBaseUrl: string | null
  lanApiBaseUrls: string[]
  networkEndpoints: NetworkEndpoint[]
  cookieFilePath: string
  lastInitError: string | null
}

type ModelsResponse = {
  models: string[]
  defaultModel: string
}

type LogEntry = {
  id: string
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
}

type Banner = {
  tone: 'success' | 'error' | 'info'
  text: string
}

type CookiesResponse = {
  raw: string
}

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

function formatDate(value: string | null): string {
  if (!value) return '暂无记录'

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
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`

  const hours = Math.floor(minutes / 60)
  return `${hours} 小时 ${minutes % 60} 分`
}

function cookieStatusLabel(status: CookieInspection['status'] | undefined) {
  if (!status) return '待检查'
  if (status === 'valid') return '正常'
  if (status === 'expiring') return '即将过期'
  if (status === 'expired') return '已过期'
  return '缺失'
}

function logLevelLabel(level: LogEntry['level']) {
  if (level === 'info') return '信息'
  if (level === 'warn') return '警告'
  if (level === 'error') return '错误'
  return '调试'
}

function mergeLogs(current: LogEntry[], incoming: LogEntry[]) {
  const map = new Map(current.map((entry) => [entry.id, entry]))
  incoming.forEach((entry) => {
    map.set(entry.id, entry)
  })

  return [...map.values()]
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
    .slice(-200)
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [modelDirty, setModelDirty] = useState(false)
  const [cookieText, setCookieText] = useState('')
  const [cookieDirty, setCookieDirty] = useState(false)
  const [proxyInput, setProxyInput] = useState('')
  const [proxyDirty, setProxyDirty] = useState(false)
  const [anchorInput, setAnchorInput] = useState('')
  const [anchorDirty, setAnchorDirty] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [banner, setBanner] = useState<Banner | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const reconnectTimer = useRef<number | null>(null)

  const fallbackApiBase = new URL('/v1', window.location.origin).toString()
  const localApiBase = status?.localApiBaseUrl ?? fallbackApiBase
  const lanApiBase = status?.lanApiBaseUrls[0] ?? null
  const primaryApiBase = lanApiBase ?? localApiBase
  const isBusy = busyAction !== null
  const serviceLabel = status?.service === 'running' ? '运行中' : '已停止'
  const cookieLabel = cookieStatusLabel(status?.cookieInspection.status)
  const missingCookies = status?.cookieInspection.requiredMissing.length
    ? status.cookieInspection.requiredMissing.join('、')
    : '无'

  const clearReconnectTimer = () => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current)
      reconnectTimer.current = null
    }
  }

  const loadStatus = useCallback(
    async (syncProxy = false) => {
      const next = await requestJson<StatusResponse>('/admin/status')
      setStatus(next)

      if (syncProxy || !proxyDirty) {
        setProxyInput(next.proxy ?? '')
      }

      if (!anchorDirty) {
        setAnchorInput(next.anchor.url ?? '')
      }

      if (!modelDirty) {
        setDefaultModel(next.defaultModel)
      }
    },
    [anchorDirty, modelDirty, proxyDirty],
  )

  const loadModels = useCallback(
    async (forceSync = false) => {
      const next = await requestJson<ModelsResponse>('/admin/models')
      setModels(next.models)

      if (forceSync || !modelDirty) {
        setDefaultModel(next.defaultModel)
      }
    },
    [modelDirty],
  )

  const loadCookies = useCallback(
    async (forceSync = false) => {
      const next = await requestJson<CookiesResponse>('/admin/cookies')
      if (forceSync || !cookieDirty) {
        setCookieText(next.raw)
      }
    },
    [cookieDirty],
  )

  const loadLogs = useCallback(async () => {
    const next = await requestJson<{ logs: LogEntry[] }>('/admin/logs?lines=200')
    setLogs((current) => mergeLogs(current, next.logs))
  }, [])

  const loadInitialData = useCallback(async () => {
    await Promise.all([loadStatus(true), loadModels(true), loadCookies(true), loadLogs()])
  }, [loadCookies, loadLogs, loadModels, loadStatus])

  const refreshDashboard = useCallback(async () => {
    await Promise.all([loadStatus(), loadLogs()])
  }, [loadLogs, loadStatus])

  useEffect(() => {
    void loadInitialData().catch((error: Error) => {
      setBanner({ tone: 'error', text: error.message })
    })

    const interval = window.setInterval(() => {
      void refreshDashboard().catch(() => undefined)
    }, 15000)

    return () => window.clearInterval(interval)
  }, [loadInitialData, refreshDashboard])

  useEffect(() => {
    let cancelled = false
    let source: EventSource | null = null

    const connect = () => {
      if (cancelled) return

      source = new EventSource('/admin/logs/stream')

      source.onmessage = (event) => {
        try {
          const next = JSON.parse(event.data) as LogEntry
          setLogs((current) => mergeLogs(current, [next]))
        } catch {
          // ignore malformed event
        }
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
  }, [])

  useEffect(() => {
    if (!guideOpen) return undefined

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGuideOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [guideOpen])

  const runAction = async (successText: string, handler: () => Promise<void>, fallbackError?: string) => {
    setBusyAction(successText)
    setBanner(null)

    try {
      await handler()
      setBanner({ tone: 'success', text: successText })
    } catch (error) {
      setBanner({
        tone: 'error',
        text: error instanceof Error ? error.message : fallbackError ?? '操作失败',
      })
    } finally {
      setBusyAction(null)
    }
  }

  const saveCookies = async () => {
    await runAction(
      'Cookie 已保存',
      async () => {
        const next = await requestJson<CookiesResponse>('/admin/cookies', {
          method: 'POST',
          body: JSON.stringify({ raw: cookieText }),
        })
        setCookieText(next.raw)
        setCookieDirty(false)
        await loadStatus(true)
      },
      '保存 Cookie 失败',
    )
  }

  const saveDefaultModel = async () => {
    if (!defaultModel) {
      setBanner({ tone: 'error', text: '请先选择默认模型' })
      return
    }

    await runAction(
      '默认模型已保存',
      async () => {
        const next = await requestJson<{ defaultModel: string }>('/admin/models', {
          method: 'POST',
          body: JSON.stringify({ defaultModel }),
        })
        setDefaultModel(next.defaultModel)
        setModelDirty(false)
        await Promise.all([loadStatus(), loadModels(true)])
      },
      '保存默认模型失败',
    )
  }

  const saveProxy = async () => {
    await runAction(
      '代理已保存',
      async () => {
        await requestJson('/admin/proxy', {
          method: 'POST',
          body: JSON.stringify({ proxy: proxyInput.trim() || null }),
        })
        setProxyDirty(false)
        await loadStatus(true)
      },
      '保存代理失败',
    )
  }

  const saveAnchor = async () => {
    await runAction(
      '来源会话已保存',
      async () => {
        await requestJson('/admin/anchor', {
          method: 'POST',
          body: JSON.stringify({ url: anchorInput.trim() || null }),
        })
        setAnchorDirty(false)
        await loadStatus()
      },
      '保存来源会话失败',
    )
  }

  const controlService = async (action: 'start' | 'stop' | 'restart') => {
    const successText = action === 'start' ? '服务已启动' : action === 'stop' ? '服务已停止' : '服务已重启'

    await runAction(
      successText,
      async () => {
        await requestJson('/admin/service', {
          method: 'POST',
          body: JSON.stringify({ action }),
        })
        await refreshDashboard()
      },
      '服务操作失败',
    )
  }

  const copyValue = async (value: string, successText: string, failureText: string) => {
    try {
      const copied = await copyText(value)
      if (!copied) {
        throw new Error('复制失败')
      }
      setBanner({ tone: 'info', text: successText })
    } catch {
      setBanner({ tone: 'error', text: failureText })
    }
  }

  const copyEndpoint = async () => {
    await copyValue(primaryApiBase, '接口地址已复制', '复制失败，请手动复制接口地址。')
  }

  const copyLanEndpoint = async () => {
    if (!lanApiBase) {
      setBanner({ tone: 'error', text: '当前没有检测到可用的局域网地址。' })
      return
    }

    await copyValue(lanApiBase, '局域网地址已复制', '复制失败，请手动复制局域网地址。')
  }

  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>

      {guideOpen ? (
        <div className="modal-backdrop" onClick={() => setGuideOpen(false)} role="presentation">
          <section
            aria-labelledby="guide-title"
            aria-modal="true"
            className="modal-panel"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="panel-head">
              <div className="panel-title">
                <FileText size={18} />
                <h2 id="guide-title">使用说明</h2>
              </div>
              <button
                aria-label="关闭使用说明"
                className="icon-button"
                onClick={() => setGuideOpen(false)}
                type="button"
              >
                <X size={16} />
              </button>
            </div>

            <div className="guide-list">
              <div className="guide-step">
                <strong>1. 先保存 Cookie</strong>
                <p>把浏览器导出的 Cookie JSON 粘贴进来，然后点击“保存 Cookie”。没有这一步，服务无法正常工作。</p>
              </div>
              <div className="guide-step">
                <strong>2. 选择默认模型</strong>
                <p>从下拉列表里选一个常用模型，再点击“保存模型”。之后新的请求会默认使用这个模型。</p>
              </div>
              <div className="guide-step">
                <strong>3. 点击启动服务</strong>
                <p>启动后就可以把接口地址填进其他工具。端口如果被占用，应用会自动换一个可用端口。</p>
              </div>
              <div className="guide-step">
                <strong>4. 局域网设备这样连</strong>
                <p>如果你要让手机或同一网络下的其他电脑使用，请复制“局域网地址”，不要复制 127.0.0.1。</p>
              </div>
            </div>

            <div className="guide-note">
              <strong>本机地址：</strong>
              {localApiBase}
              <br />
              <strong>局域网地址：</strong>
              {lanApiBase ?? '当前未检测到可用的局域网地址'}
            </div>
          </section>
        </div>
      ) : null}

      <main className="page-shell app-shell" id="main-content">
        <header className="page-header">
          <div className="header-copy">
            <div className="eyebrow">普通用户版</div>
            <h1>Gemini Bridge</h1>
            <p>先保存 Cookie，选择默认模型，再点击启动。常用操作都放在第一页，现在也支持同一局域网里的其他设备直接接入。</p>
          </div>

          <div className="header-actions">
            <button className="soft-button" onClick={() => setGuideOpen(true)} type="button">
              <FileText size={16} />
              使用说明
            </button>

            <button className="soft-button" onClick={() => void loadInitialData()} type="button">
              <RefreshCw size={16} />
              刷新
            </button>

            <button className="soft-button" onClick={() => void copyEndpoint()} type="button">
              <Copy size={16} />
              复制接口
            </button>

            <button className="soft-button" onClick={() => void copyLanEndpoint()} type="button">
              <Network size={16} />
              复制局域网地址
            </button>

            <Link className="soft-link" to="/logs">
              会话记录
            </Link>
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

        <section className="summary-strip">
          <div className="summary-item">
            <span className="summary-label">服务状态</span>
            <strong>{serviceLabel}</strong>
            <span className="summary-text">{status ? formatDuration(status.uptimeMs) : '正在加载'}</span>
          </div>
          <div className="summary-item">
            <span className="summary-label">Cookie 状态</span>
            <strong>{cookieLabel}</strong>
            <span className="summary-text">
              {missingCookies === '无' ? '关键项齐全' : `缺少：${missingCookies}`}
            </span>
          </div>
          <div className="summary-item summary-item-wide">
            <span className="summary-label">当前推荐地址</span>
            <strong>/v1</strong>
            <span className="summary-text">{primaryApiBase}</span>
          </div>
        </section>

        <section className="content-stack">
          <article className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <Server size={18} />
                <h2>服务控制</h2>
              </div>
              <span className="status-pill">{serviceLabel}</span>
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="default-model">
                默认模型
              </label>
              <div className="inline-form">
                <select
                  className="text-input select-input"
                  id="default-model"
                  onChange={(event) => {
                    setDefaultModel(event.target.value)
                    setModelDirty(true)
                  }}
                  value={defaultModel}
                >
                  <option disabled value="">
                    {models.length === 0 ? '正在加载模型列表' : '请选择默认模型'}
                  </option>
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>

                <button
                  className="primary-button"
                  disabled={isBusy || models.length === 0 || !defaultModel || !modelDirty}
                  onClick={() => void saveDefaultModel()}
                  type="button"
                >
                  <Save size={16} />
                  保存模型
                </button>
              </div>
              <p className="field-help">新请求会默认使用这里选中的模型。服务运行中保存后，会自动重新连接。</p>
            </div>

            <div className="mini-list">
              <div>
                <span>最近请求</span>
                <strong>{formatDate(status?.lastRequestAt ?? null)}</strong>
              </div>
              <div>
                <span>请求 / 错误</span>
                <strong>
                  {status?.requestCount ?? 0} / {status?.errorCount ?? 0}
                </strong>
              </div>
              <div>
                <span>本机地址</span>
                <strong>{localApiBase}</strong>
              </div>
              <div>
                <span>局域网地址</span>
                <strong>{lanApiBase ?? '当前未检测到'}</strong>
              </div>
            </div>

            <div className="action-row">
              <button
                className="primary-button"
                disabled={isBusy || status?.service === 'running'}
                onClick={() => void controlService('start')}
                type="button"
              >
                <PlayCircle size={16} />
                启动服务
              </button>

              <button
                className="soft-button"
                disabled={isBusy || status?.service !== 'running'}
                onClick={() => void controlService('restart')}
                type="button"
              >
                <RefreshCw size={16} />
                重启服务
              </button>

              <button
                className="soft-button"
                disabled={isBusy || status?.service !== 'running'}
                onClick={() => void controlService('stop')}
                type="button"
              >
                <Square size={16} />
                停止服务
              </button>
            </div>

            <p className="field-help">
              如果要给手机或同一网络下的其他电脑使用，请复制“局域网地址”。本机自己使用时，复制“本机地址”也可以。
            </p>

            {status?.lastInitError ? <div className="error-box">{status.lastInitError}</div> : null}
          </article>

          <article className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <Cookie size={18} />
                <h2>Cookie</h2>
              </div>
              <span className="status-pill">{cookieLabel}</span>
            </div>

            <div className="field-group">
              <label className="field-label" htmlFor="cookie-input">
                Cookie JSON
              </label>
              <textarea
                className="editor"
                id="cookie-input"
                onChange={(event) => {
                  setCookieText(event.target.value)
                  setCookieDirty(true)
                }}
                spellCheck={false}
                value={cookieText}
              />
              <div className="panel-foot">
                <div className="cookie-note">
                  <span>关键字段：__Secure-1PSID、__Secure-1PSIDTS</span>
                  <span>保存位置：{status?.cookieFilePath ?? '正在加载'}</span>
                </div>
                <button
                  className="primary-button"
                  disabled={isBusy || !cookieDirty}
                  onClick={() => void saveCookies()}
                  type="button"
                >
                  <Save size={16} />
                  保存 Cookie
                </button>
              </div>
            </div>
          </article>

          <article className="panel advanced-panel">
            <details>
              <summary>
                <div className="panel-title">
                  <Link2 size={18} />
                  <h2>高级设置</h2>
                </div>
                <span className="status-pill">按需使用</span>
              </summary>

              <div className="advanced-content">
                <div className="field-group">
                  <label className="field-label" htmlFor="proxy-input">
                    代理地址
                  </label>
                  <div className="inline-form">
                    <input
                      className="text-input"
                      id="proxy-input"
                      onChange={(event) => {
                        setProxyInput(event.target.value)
                        setProxyDirty(true)
                      }}
                      placeholder="例如：http://127.0.0.1:7890"
                      value={proxyInput}
                    />
                    <button
                      className="primary-button"
                      disabled={isBusy || !proxyDirty}
                      onClick={() => void saveProxy()}
                      type="button"
                    >
                      <Save size={16} />
                      保存代理
                    </button>
                  </div>
                  <p className="field-help">只有你的网络环境需要代理时再填写。留空就是关闭代理。</p>
                </div>

                <div className="field-group">
                  <label className="field-label" htmlFor="anchor-input">
                    来源会话链接
                  </label>
                  <div className="inline-form">
                    <input
                      className="text-input"
                      id="anchor-input"
                      onChange={(event) => {
                        setAnchorInput(event.target.value)
                        setAnchorDirty(true)
                      }}
                      placeholder="可留空"
                      value={anchorInput}
                    />
                    <button
                      className="primary-button"
                      disabled={isBusy || !anchorDirty}
                      onClick={() => void saveAnchor()}
                      type="button"
                    >
                      <Save size={16} />
                      保存会话
                    </button>
                  </div>
                  <p className="field-help">只有你明确知道用途时再填写。不确定就留空。</p>
                </div>

                <div className="mini-list">
                  <div>
                    <span>生效代理</span>
                    <strong>{status?.effectiveProxy ?? '未启用'}</strong>
                  </div>
                  <div>
                    <span>监听主机</span>
                    <strong>{status?.host ?? '正在加载'}</strong>
                  </div>
                  <div>
                    <span>监听端口</span>
                    <strong>{status?.port ?? '正在加载'}</strong>
                  </div>
                  <div>
                    <span>可用地址数量</span>
                    <strong>{status?.networkEndpoints.length ?? 0}</strong>
                  </div>
                </div>
              </div>
            </details>
          </article>

          <article className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <TerminalSquare size={18} />
                <h2>运行日志</h2>
              </div>
              <span className="status-pill">{logs.length} 条</span>
            </div>

            <div className="log-console" role="log">
              {logs.length === 0 ? (
                <div className="log-empty">暂无日志</div>
              ) : (
                logs.map((entry) => (
                  <div className="log-line" key={entry.id}>
                    <span className="log-time">{formatDate(entry.timestamp)}</span>
                    <span className="log-level">{logLevelLabel(entry.level)}</span>
                    <span className="log-message">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </article>
        </section>
      </main>
    </>
  )
}
