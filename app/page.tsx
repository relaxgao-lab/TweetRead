"use client"

import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react"
import Image from "next/image"

import { ACCOUNTS } from "@/config/accounts"
import type { Tweet } from "@/lib/twitter"
import { formatRelativeTime, formatCount } from "@/lib/twitter"
import {
  Heart, Repeat2, MessageCircle, Eye, RefreshCw, ChevronDown, ChevronUp,
  Send, Mic, StopCircle, Volume2, VolumeX, X, Sparkles, ExternalLink,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { whisperSpeechService, type SpeechStatus } from "@/app/conversation/whisper-speech-service"

// ─── 常量 ─────────────────────────────────────────────────────────────────────
const MIN_CHAT_WIDTH = 280
const MAX_CHAT_WIDTH_PERCENT = 70
const DEFAULT_CHAT_WIDTH = 420
// ─── 类型 ─────────────────────────────────────────────────────────────────────
type SheetState = "hidden" | "half" | "full"
type TweetCache = Record<string, { tweets: Tweet[]; hasMore: boolean; nextCursor?: string; loadedAt: number }>
interface Message { role: "user" | "assistant"; content: string }
interface LookupResult {
  phonetic?: string
  partOfSpeech?: string
  translation: string
  definition?: string
  breakdown?: string
  grammar?: string
  example?: string
  exampleZh?: string
}
interface LookupPopupState { text: string; anchorX: number; anchorY: number; tweet: Tweet }

// ─── 快捷提问 + 配色 ───────────────────────────────────────────────────────────
const PRESET_PROMPTS = [
  { label: "翻译",     text: "请将这条推文翻译成中文，并保持原意。" },
  { label: "解释背景", text: "请解释这条推文的背景，帮我理解它的含义和重要性。" },
  { label: "总结要点", text: "请用简洁的中文总结这条推文的核心要点。" },
  { label: "市场影响", text: "请分析这条信息对市场或相关领域可能的影响。" },
]

const pastelColors = [
  { bg: "bg-slate-100",  border: "border-slate-200",  text: "text-slate-700",  hover: "hover:bg-slate-200/60"  },
  { bg: "bg-violet-100", border: "border-violet-200", text: "text-violet-700", hover: "hover:bg-violet-200/60" },
  { bg: "bg-pink-100",   border: "border-pink-200",   text: "text-pink-700",   hover: "hover:bg-pink-200/60"   },
  { bg: "bg-amber-100",  border: "border-amber-200",  text: "text-amber-800",  hover: "hover:bg-amber-200/60"  },
]
const voiceColor = { bg: "bg-emerald-100", border: "border-emerald-200", text: "text-emerald-700", hover: "hover:bg-emerald-200/60" }

// ─── 翻译缓存（localStorage，上限 500 条）────────────────────────────────────────
const TRANS_CACHE_KEY = "tweet-translations-v2"
const TRANS_CACHE_LIMIT = 500

function loadTransCache(): Record<string, string> {
  try {
    if (typeof window === "undefined") return {}
    return JSON.parse(localStorage.getItem(TRANS_CACHE_KEY) ?? "{}") as Record<string, string>
  } catch { return {} }
}

function saveTransCache(cache: Record<string, string>) {
  try {
    const entries = Object.entries(cache)
    const trimmed = entries.length > TRANS_CACHE_LIMIT
      ? Object.fromEntries(entries.slice(entries.length - TRANS_CACHE_LIMIT))
      : cache
    localStorage.setItem(TRANS_CACHE_KEY, JSON.stringify(trimmed))
  } catch {}
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────
function buildSceneMeta(tweet: Tweet) {
  const account = ACCOUNTS.find((a) => a.userName === tweet.author.userName)
  const authorContext = account?.aiContext ?? `This tweet is from @${tweet.author.userName} (${tweet.author.name}).`
  return {
    aiRole: "a professional tweet analyst and financial/tech news interpreter",
    userRole: "reader",
    context: `${authorContext}\n\nTweet by @${tweet.author.userName} (${tweet.author.name}) — ${tweet.createdAt}:\n"${tweet.text}"\n\nEngagement: ${tweet.likeCount} likes, ${tweet.retweetCount} retweets, ${tweet.replyCount} replies, ${tweet.viewCount} views.`,
    scenario: tweet.text,
  }
}

function extractSpeakContent(content: string): string {
  const m = content.match(/\[\s*SPEAK\s*\]([\s\S]*?)\[\s*\/\s*SPEAK\s*\]/i)
  if (m) return m[1].trim()
  return content.replace(/\[\s*\/?\s*SPEAK\s*\]/gi, "").trim() || content
}

function smartCase(text: string): string {
  const alpha = text.replace(/[^a-zA-Z]/g, "")
  if (!alpha.length) return text
  const upperRatio = (text.match(/[A-Z]/g)?.length ?? 0) / alpha.length
  if (upperRatio < 0.7) return text
  return text.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())
}

// ─── 页面组件 ──────────────────────────────────────────────────────────────────
export default function HomePage() {
  // ── 推文 feed ──
  const [activeTab, setActiveTab] = useState(ACCOUNTS[0].userName)
  const [cache, setCache] = useState<TweetCache>({})
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeAccount = ACCOUNTS.find((a) => a.userName === activeTab) ?? ACCOUNTS[0]
  const current = cache[activeTab]
  const tweets = current?.tweets ?? []

  // ── AI 面板：选中推文 + 聊天 ──
  const [selectedTweet, setSelectedTweet] = useState<Tweet | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [inputText, setInputText] = useState("")
  const [isChatLoading, setIsChatLoading] = useState(false)
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle")
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(false)
  const isSpeechEnabledRef = useRef(false)
  isSpeechEnabledRef.current = isSpeechEnabled

  // ── AI 面板：宽度 + 开关 ──
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartX = useRef(0)
  const resizeStartWidth = useRef(0)
  const lastChatWidthRef = useRef(DEFAULT_CHAT_WIDTH)

  const [isMobile, setIsMobile] = useState(false)
  const [isChatOpen, setIsChatOpen] = useState(false)
  const [allowChatTransition, setAllowChatTransition] = useState(false)
  const [mounted, setMounted] = useState(false)
  const justRestoredOpenRef = useRef(false)

  // ── 手机端底部抽屉 ──
  const [sheetState, setSheetState] = useState<SheetState>("hidden")
  const [currentDragHeight, setCurrentDragHeight] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [sheetHeights, setSheetHeights] = useState({ hidden: 0, half: 480, full: 700 })
  const sheetTouchStartY = useRef(0)
  const sheetTouchStartH = useRef(0)

  // ── 查词气泡 ──
  const [lookupPopup, setLookupPopup] = useState<LookupPopupState | null>(null)
  const [lookupResult, setLookupResult] = useState<LookupResult | null>(null)
  const [isLookupLoading, setIsLookupLoading] = useState(false)
  // 手机端：选中文本后先暂存，等用户点击「查词」按钮才触发查询
  const [pendingLookup, setPendingLookup] = useState<{ text: string; anchorX: number; anchorY: number; tweet: Tweet } | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const transcriptCallback = useRef<((text: string) => void) | null>(null)

  // 桌面端：isChatOpen 控制右侧面板；手机端：sheetState 控制底部抽屉
  const effectiveChatOpen = isMobile ? sheetState !== "hidden" : isChatOpen
  const sheetHeight = currentDragHeight ?? sheetHeights[sheetState]

  // ── 初始化 ──
  useLayoutEffect(() => {
    if (typeof window === "undefined") return

    const updateSheetHeights = () => {
      setSheetHeights({
        hidden: 0,
        half: Math.round(window.innerHeight * 0.62),
        full: window.innerHeight - 44,
      })
    }
    updateSheetHeights()
    window.addEventListener("resize", updateSheetHeights)

    // 恢复宽度
    try {
      const saved = localStorage.getItem("tweet-home-chat-width")
      if (saved) {
        const n = parseInt(saved, 10)
        if (!isNaN(n) && n >= MIN_CHAT_WIDTH) {
          const clamped = Math.min(n, window.innerWidth * (MAX_CHAT_WIDTH_PERCENT / 100))
          setChatWidth(clamped)
          lastChatWidthRef.current = clamped
        }
      }
    } catch {}

    const isM = window.matchMedia("(max-width: 767px)").matches
    setIsMobile(isM)
    if (!isM) {
      try {
        const saved = localStorage.getItem("tweet-home-chat-open")
        if (saved !== "false") {
          setAllowChatTransition(false)
          justRestoredOpenRef.current = true
          setIsChatOpen(true)
          return () => window.removeEventListener("resize", updateSheetHeights)
        }
      } catch {}
    }
    let raf1: number, raf2: number
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setAllowChatTransition(true))
    })
    return () => {
      window.removeEventListener("resize", updateSheetHeights)
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [])

  useEffect(() => { setMounted(true) }, [])

  // 恢复打开后再两帧开启过渡（避免初次展开有动画）
  useEffect(() => {
    if (!effectiveChatOpen || !justRestoredOpenRef.current) return
    let raf1: number, raf2: number
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        justRestoredOpenRef.current = false
        setAllowChatTransition(true)
      })
    })
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2) }
  }, [effectiveChatOpen])

  // 持久化开关
  useEffect(() => {
    if (!mounted || typeof window === "undefined") return
    localStorage.setItem("tweet-home-chat-open", isChatOpen.toString())
  }, [mounted, isChatOpen])

  // 响应式监听
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)")
    const update = () => setIsMobile(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])

  // ── 拖拽宽度 ──
  const handleResizeStart = (e: React.MouseEvent) => {
    setIsResizing(true)
    resizeStartX.current = e.clientX
    resizeStartWidth.current = chatWidth
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing) return
      const maxW = window.innerWidth * (MAX_CHAT_WIDTH_PERCENT / 100)
      const newW = Math.max(MIN_CHAT_WIDTH, Math.min(resizeStartWidth.current + (resizeStartX.current - e.clientX), maxW))
      setChatWidth(newW)
      lastChatWidthRef.current = newW
    }
    const onUp = () => {
      if (!isResizing) return
      setIsResizing(false)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      localStorage.setItem("tweet-home-chat-width", lastChatWidthRef.current.toString())
    }
    if (isResizing) {
      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    }
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp) }
  }, [isResizing])

  // ── 手机端底部抽屉拖拽 ──
  const handleSheetDragStart = useCallback((e: React.TouchEvent) => {
    setIsDragging(true)
    sheetTouchStartY.current = e.touches[0].clientY
    sheetTouchStartH.current = currentDragHeight ?? sheetHeights[sheetState]
  }, [currentDragHeight, sheetHeights, sheetState])

  const handleSheetDragMove = useCallback((e: React.TouchEvent) => {
    if (!isDragging) return
    const deltaY = sheetTouchStartY.current - e.touches[0].clientY
    const newH = Math.max(0, Math.min(sheetHeights.full, sheetTouchStartH.current + deltaY))
    setCurrentDragHeight(newH)
  }, [isDragging, sheetHeights])

  const handleSheetDragEnd = useCallback(() => {
    setIsDragging(false)
    const h = currentDragHeight ?? sheetHeights[sheetState]
    setCurrentDragHeight(null)
    const distances: Record<SheetState, number> = {
      hidden: Math.abs(h - 0),
      half: Math.abs(h - sheetHeights.half),
      full: Math.abs(h - sheetHeights.full),
    }
    const nearest = (Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0]) as SheetState
    setSheetState(nearest)
  }, [currentDragHeight, sheetHeights, sheetState])

  // ── 推文翻译（SSE 流式 + localStorage 缓存）──
  const translateTweets = useCallback(async (userName: string, tweets: Tweet[]) => {
    const transCache = loadTransCache()
    const needTranslate = tweets.filter((t) => !transCache[t.id])

    // 先把缓存命中的翻译立即填入
    if (Object.keys(transCache).length > 0) {
      setCache((prev) => {
        const tab = prev[userName]
        if (!tab) return prev
        const updated = tab.tweets.map((t) => transCache[t.id] ? { ...t, textZh: transCache[t.id] } : t)
        return { ...prev, [userName]: { ...tab, tweets: updated } }
      })
    }

    if (!needTranslate.length) return

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: needTranslate.map((t) => ({ id: t.id, text: t.text })) }),
      })
      if (!res.ok || !res.body) return

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      const newEntries: Record<string, string> = {}

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split("\n\n")
        buf = parts.pop() ?? ""
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith("data: ")) continue
          const payload = line.slice(6)
          if (payload === "[DONE]") break
          try {
            const { id, textZh } = JSON.parse(payload) as { id: string; textZh: string }
            newEntries[id] = textZh
            setCache((prev) => {
              const tab = prev[userName]
              if (!tab) return prev
              const updated = tab.tweets.map((t) => t.id === id ? { ...t, textZh } : t)
              return { ...prev, [userName]: { ...tab, tweets: updated } }
            })
          } catch {}
        }
      }

      // 持久化新翻译到 localStorage
      if (Object.keys(newEntries).length > 0) {
        saveTransCache({ ...transCache, ...newEntries })
      }
    } catch (err) {
      console.error("translateTweets error:", err)
    }
  }, [])

  // ── 推文加载 ──
  const loadTweets = useCallback(async (userName: string, cursor?: string) => {
    const isLoadMore = !!cursor
    if (isLoadMore) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ userName })
      if (cursor) params.set("cursor", cursor)
      const res = await fetch(`/api/tweets?${params}`)
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const data = await res.json()
      const incoming: Tweet[] = data.tweets
      setCache((prev) => {
        const existing = prev[userName]?.tweets ?? []
        return { ...prev, [userName]: { tweets: isLoadMore ? [...existing, ...incoming] : incoming, hasMore: data.hasMore, nextCursor: data.nextCursor, loadedAt: Date.now() } }
      })
      translateTweets(userName, incoming)
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false); setLoadingMore(false)
    }
  }, [translateTweets])

  useEffect(() => {
    const cached = cache[activeTab]
    if (!cached || Date.now() - cached.loadedAt > 5 * 60 * 1000) loadTweets(activeTab)
  }, [activeTab, cache, loadTweets])

  // ── 语音 ──
  useEffect(() => {
    transcriptCallback.current = (text: string) => {
      setInputText((prev) => prev + text)
      textareaRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    whisperSpeechService.updateConfig({
      onTranscript: (text) => transcriptCallback.current?.(text),
      onError: (err) => { setSpeechError(err); setSpeechStatus("idle") },
      onStatusChange: setSpeechStatus,
    })
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  // ── 发送消息（SSE 流式）──
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isChatLoading || !selectedTweet) return
    const userMsg: Message = { role: "user", content: text }
    setMessages((prev) => [...prev, userMsg])
    setInputText("")
    setIsChatLoading(true)
    setSpeechError(null)
    // 手机端：消息发送时确保抽屉打开
    if (isMobile && sheetState === "hidden") setSheetState("half")

    let accumulated = ""
    let firstChunk = true
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [...messages, userMsg], sceneMeta: buildSceneMeta(selectedTweet) }),
      })
      if (!res.ok) throw new Error(`Chat API ${res.status}`)
      if (!res.body) throw new Error("No response body")

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const raw = line.slice(6).trim()
          if (raw === "[DONE]") continue
          try {
            const { delta } = JSON.parse(raw)
            if (delta) {
              accumulated += delta
              if (firstChunk) {
                firstChunk = false
                setIsChatLoading(false)
                setMessages((prev) => [...prev, { role: "assistant", content: accumulated }])
              } else {
                setMessages((prev) => {
                  const copy = [...prev]
                  copy[copy.length - 1] = { role: "assistant", content: accumulated }
                  return copy
                })
              }
            }
          } catch {}
        }
      }

      if (isSpeechEnabledRef.current && accumulated) {
        const speakText = extractSpeakContent(accumulated)
        if (speakText) try { await whisperSpeechService.speak(speakText) } catch { setSpeechError("语音播放失败") }
      }
    } catch { setSpeechError("对话请求失败，请稍后重试") }
    finally { setIsChatLoading(false) }
  }, [isChatLoading, selectedTweet, messages, isMobile, sheetState])

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); sendMessage(inputText) }

  const handleVoiceToggle = async () => {
    if (speechStatus === "recording") { whisperSpeechService.stopListening(); setSpeechStatus("idle"); return }
    setSpeechError(null); setSpeechStatus("recording")
    try { await whisperSpeechService.startListening() }
    catch { setSpeechStatus("idle"); setSpeechError("无法启动录音") }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (inputText.trim() && !isChatLoading && speechStatus !== "recording" && speechStatus !== "processing") sendMessage(inputText)
    }
  }

  // ── 查词 ──
  const handleTextSelect = useCallback(async (text: string, anchorX: number, anchorY: number, tweet: Tweet) => {
    setLookupPopup({ text, anchorX, anchorY, tweet })
    setLookupResult(null)
    setIsLookupLoading(true)
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, context: tweet.text }),
      })
      const data: LookupResult = await res.json()
      setLookupResult(data)
    } catch {
      setLookupResult({ translation: "查询失败" })
    } finally {
      setIsLookupLoading(false)
    }
  }, [])

  // 点击气泡外部关闭
  useEffect(() => {
    if (!lookupPopup) return
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest("[data-lookup-popup]")) {
        setLookupPopup(null)
        window.getSelection()?.removeAllRanges()
      }
    }
    document.addEventListener("mousedown", handler)
    document.addEventListener("touchstart", handler)
    return () => { document.removeEventListener("mousedown", handler); document.removeEventListener("touchstart", handler) }
  }, [lookupPopup])

  // 点击「查词」按钮外部时关闭暂存查词
  // 只监听 mousedown（不监听 touchstart），避免用户拖动选区手柄时误触发关闭
  useEffect(() => {
    if (!pendingLookup) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest("[data-pending-lookup]")) {
        setPendingLookup(null)
        window.getSelection()?.removeAllRanges()
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [pendingLookup])

  // selectionchange：用户拖动手柄扩大/缩小选区时，只更新文本（不更新位置，避免按钮跳动）
  const pendingLookupRef = useRef(pendingLookup)
  pendingLookupRef.current = pendingLookup
  useEffect(() => {
    const handleSelectionChange = () => {
      if (!pendingLookupRef.current) return
      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!text) {
        setPendingLookup(null)
        return
      }
      // 只更新 text，按钮位置保持初始 readSelection 时的 rect.bottom
      setPendingLookup(prev => prev ? { ...prev, text } : null)
    }
    document.addEventListener("selectionchange", handleSelectionChange)
    return () => document.removeEventListener("selectionchange", handleSelectionChange)
  }, [])

  // ── 推文点击：手机展开底部抽屉；桌面打开 AI 面板 ──
  // 仅选中推文（文章 onClick：手机端只高亮，桌面端顺带开 AI）
  const handleTweetClick = (tweet: Tweet) => {
    if (selectedTweet?.id !== tweet.id) { setSelectedTweet(tweet); setMessages([]) }
    if (!isMobile && !effectiveChatOpen) setIsChatOpen(true)
  }

  // 选中推文 + 打开 AI（Sparkles 按钮专用）
  const handleOpenAI = (tweet: Tweet) => {
    if (selectedTweet?.id !== tweet.id) { setSelectedTweet(tweet); setMessages([]) }
    if (isMobile) setSheetState("half")
    else if (!effectiveChatOpen) setIsChatOpen(true)
  }

  const noTransition = !allowChatTransition || isResizing || justRestoredOpenRef.current

  return (
    <div
      className="h-screen flex flex-col overflow-hidden relative mobile-bg-scroll bg-fixed"
      style={{ background: "linear-gradient(135deg, #dce8f0 0%, #ede8e0 40%, #e4ece6 100%)" }}
    >
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] pointer-events-none z-0" />

      {/* 内容层 */}
      <div className="relative z-10 flex flex-col h-full min-h-0 pt-[env(safe-area-inset-top)]">

        {/* ── Header ── */}
        <header className="shrink-0 bg-white/80 border-b border-gray-200 shadow-sm backdrop-blur-sm">
          <div className="px-4 py-2.5 flex items-center gap-3">
            <h1 className="text-lg font-bold text-gray-900 tracking-tight shrink-0">TweetRead</h1>
            {/* Tab 栏 */}
            <div className="flex-1 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {ACCOUNTS.map((account) => (
                <button
                  key={account.userName}
                  onClick={() => { setActiveTab(account.userName); setError(null) }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all ${
                    activeTab === account.userName
                      ? "bg-gray-900 text-white"
                      : "bg-gray-100/80 text-gray-600 hover:bg-gray-200/80"
                  }`}
                >
                  <span className="text-xs opacity-70">@</span>
                  {account.userName}
                </button>
              ))}
            </div>
            <Button
              variant="ghost" size="icon"
              onClick={() => loadTweets(activeTab)}
              disabled={loading}
              className="text-gray-500 hover:text-gray-900 shrink-0"
              title="刷新"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </header>



        {/* ── 主体：推文列表 + AI 面板 ── */}
        <div className="flex-1 flex overflow-hidden min-h-0">

          {/* 左侧：推文列表 */}
          <div className="flex flex-col overflow-hidden min-w-0 flex-1">
            {activeAccount.description && (
              <div className="shrink-0 px-4 py-1.5 border-b border-gray-200/60 bg-white/50">
                <p className="text-xs text-black text-center truncate">{activeAccount.description}</p>
              </div>
            )}
            <div className="flex-1 overflow-y-auto hide-vertical-scrollbar min-h-0">
              <div className="max-w-2xl mx-auto" style={{ paddingBottom: isMobile ? "env(safe-area-inset-bottom, 16px)" : undefined }}>
                {error && (
                  <div className="mx-4 mt-4 p-3 bg-red-50/90 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center">
                    <span>{error}</span>
                    <Button variant="ghost" size="sm" onClick={() => loadTweets(activeTab)}>重试</Button>
                  </div>
                )}

                {loading && tweets.length === 0 && (
                  <div className="flex flex-col gap-3 p-4">
                    {[...Array(5)].map((_, i) => (
                      <div key={i} className="bg-white/80 rounded-xl p-4 border border-gray-200/80 animate-pulse">
                        <div className="flex gap-3">
                          <div className="w-10 h-10 rounded-full bg-gray-200 shrink-0" />
                          <div className="flex-1 space-y-2">
                            <div className="h-3 bg-gray-200 rounded w-1/3" />
                            <div className="h-3 bg-gray-200 rounded w-full" />
                            <div className="h-3 bg-gray-200 rounded w-4/5" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!loading && tweets.length === 0 && !error && (
                  <div className="text-center py-16 text-gray-400 text-sm">暂无推文</div>
                )}

                <div className="divide-y divide-gray-100/80">
                  {tweets.map((tweet, idx) => (
                    <TweetCard
                      key={tweet.id}
                      tweet={tweet}
                      index={idx}
                      isSelected={selectedTweet?.id === tweet.id}
                      onClick={() => handleTweetClick(tweet)}
                      onAiClick={() => handleOpenAI(tweet)}
                      onTextSelect={(text, ax, ay) => {
                        // 统一：选中后显示「查词」按钮，点击才查询
                        setPendingLookup({ text, anchorX: ax, anchorY: ay, tweet })
                      }}
                      isMobile={isMobile}
                    />
                  ))}
                </div>

                {current?.hasMore && (
                  <div className="flex justify-center py-6">
                    <Button
                      variant="outline" size="sm"
                      onClick={() => current?.nextCursor && loadTweets(activeTab, current.nextCursor)}
                      disabled={loadingMore}
                      className="gap-2 bg-white/80 backdrop-blur-sm"
                    >
                      {loadingMore
                        ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" />加载中...</>
                        : <><ChevronDown className="h-3.5 w-3.5" />加载更多</>}
                    </Button>
                  </div>
                )}

                <div className="h-[env(safe-area-inset-bottom,2rem)]" />
              </div>
            </div>
          </div>

          {/* ── 桌面端：拖拽条 ── */}
          {!isMobile && (
            <div
              role="separator"
              aria-label="调整 AI 窗口宽度"
              onMouseDown={handleResizeStart}
              className={`hidden md:flex shrink-0 flex-col items-center justify-center bg-gray-200/70 hover:bg-emerald-400 active:bg-emerald-500 cursor-col-resize select-none overflow-hidden ${
                isResizing ? "bg-emerald-500" : ""
              } ${effectiveChatOpen ? "w-1.5" : "w-0 pointer-events-none"}`}
              style={{ transition: noTransition ? "none" : "width 0.55s cubic-bezier(0.25, 0.1, 0.25, 1)" }}
            >
              <div className="w-0.5 h-8 rounded-full bg-gray-400 pointer-events-none shrink-0" />
            </div>
          )}

          {/* ── 桌面端：AI 面板 ── */}
          {!isMobile && (
            <div
              className={`flex flex-col shrink-0 overflow-hidden ${!effectiveChatOpen ? "pointer-events-none" : ""}`}
              style={{
                width: effectiveChatOpen ? chatWidth : 0,
                minWidth: 0,
                transition: noTransition ? "none" : "width 0.55s cubic-bezier(0.25, 0.1, 0.25, 1)",
              }}
            >
              <div
                className="flex flex-col flex-1 min-w-0 h-full bg-white/90 border-l border-gray-200 backdrop-blur-sm"
                style={{
                  width: mounted ? chatWidth : DEFAULT_CHAT_WIDTH,
                  minWidth: mounted ? MIN_CHAT_WIDTH : DEFAULT_CHAT_WIDTH,
                  transform: effectiveChatOpen ? "translateX(0)" : "translateX(100%)",
                  transition: noTransition ? "none" : "transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)",
                }}
              >
                {/* 标题栏 */}
                <div className="shrink-0 px-4 py-2 border-b border-gray-200 bg-gray-50/80 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-gray-700">AI 解读助手</h3>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {selectedTweet ? `@${selectedTweet.author.userName}` : "点击左侧推文开始分析"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button" variant="outline" size="sm"
                      onClick={() => { if (isSpeechEnabled) { whisperSpeechService.stopSpeaking(); setSpeechError(null) }; setIsSpeechEnabled(!isSpeechEnabled) }}
                      className={`shrink-0 h-8 px-2 border ${voiceColor.bg} ${voiceColor.border} ${voiceColor.text} ${voiceColor.hover}`}
                      title={isSpeechEnabled ? "关闭语音朗读" : "开启语音朗读"}
                    >
                      {isSpeechEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                      <span className="ml-1 text-xs">{isSpeechEnabled ? "语音开" : "语音关"}</span>
                    </Button>
                    <Button
                      type="button" variant="ghost" size="icon"
                      onClick={() => setIsChatOpen(false)}
                      className="h-8 w-8 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md"
                      title="关闭"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* 选中推文预览 */}
                {selectedTweet && (
                  <div className="shrink-0 border-b border-gray-200/80 bg-gray-50/50 px-4 py-3">
                    <div className="flex items-start gap-2.5">
                      {selectedTweet.author.profilePicture ? (
                        <Image
                          src={selectedTweet.author.profilePicture}
                          alt={selectedTweet.author.name}
                          width={32} height={32}
                          className="w-8 h-8 rounded-full object-cover shrink-0"
                          unoptimized
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs font-bold shrink-0">
                          {selectedTweet.author.name?.[0] ?? "?"}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1 flex-wrap">
                          <span className="text-xs font-semibold text-gray-900">{selectedTweet.author.name}</span>
                          <span className="text-xs text-gray-400">@{selectedTweet.author.userName}</span>
                          <span className="text-xs text-gray-300">·</span>
                          <span className="text-xs text-gray-400">{formatRelativeTime(selectedTweet.createdAt)}</span>
                        </div>
                        <p className="mt-1 text-xs text-gray-700 leading-relaxed whitespace-pre-wrap break-words line-clamp-5">
                          {selectedTweet.text}
                        </p>
                        {selectedTweet.url && (
                          <a
                            href={selectedTweet.url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-600 mt-1"
                          >
                            <ExternalLink className="h-2.5 w-2.5" />查看原文
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* 消息列表 */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4 hide-vertical-scrollbar">
                  {!selectedTweet && (
                    <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-12">
                      <Sparkles className="h-10 w-10 text-gray-200" />
                      <p className="text-sm font-medium text-gray-400">点击左侧推文</p>
                      <p className="text-xs text-gray-300">AI 将为你解读该推文</p>
                    </div>
                  )}
                  {selectedTweet && messages.length === 0 && (
                    <div className="text-center text-sm text-gray-500 mt-8 space-y-2">
                      <p className="font-medium">有什么问题想了解吗？</p>
                      <p className="text-xs text-gray-400">点击下方快捷按钮，或直接输入问题</p>
                    </div>
                  )}
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                      {msg.role === "user" && (
                        <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium bg-violet-500 text-white">我</div>
                      )}
                      <div className={`flex-1 min-w-0 text-sm leading-relaxed ${msg.role === "user" ? "text-right" : "text-gray-800"}`}>
                        {msg.role === "user" ? (
                          <div className="inline-block max-w-[85%] rounded-2xl bg-violet-50 border border-violet-100 px-4 py-2 text-gray-900 text-left">
                            {msg.content}
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 whitespace-pre-wrap">
                              {msg.content ? extractSpeakContent(msg.content) : (
                                <span className="inline-flex gap-0.5 text-gray-400">
                                  <span className="animate-dot-flash-1">·</span>
                                  <span className="animate-dot-flash-2">·</span>
                                  <span className="animate-dot-flash-3">·</span>
                                </span>
                              )}
                            </div>
                            {i === messages.length - 1 && speechStatus === "speaking" && (
                              <div className="flex items-center gap-2 text-xs text-emerald-600 pt-1">
                                <span className="flex items-end gap-0.5 h-4">
                                  {[1,2,3,4].map((n) => (
                                    <span key={n} className={`w-1 bg-emerald-500 rounded-full origin-bottom animate-sound-wave animate-sound-wave-${n} ${n % 2 === 0 ? "h-4" : "h-3"} inline-block`} />
                                  ))}
                                </span>
                                <Volume2 className="h-3.5 w-3.5 shrink-0" />
                                正在播放
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {isChatLoading && (
                    <div className="flex gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="inline-block rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 text-sm text-gray-500">
                          <span className="inline-flex gap-0.5">
                            <span className="animate-dot-flash-1">·</span>
                            <span className="animate-dot-flash-2">·</span>
                            <span className="animate-dot-flash-3">·</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* 快捷提问 */}
                {selectedTweet && (
                  <div className="shrink-0 px-4 py-2 border-t border-gray-100 bg-gray-50/80">
                    <div className="flex flex-wrap gap-x-3 gap-y-2 pt-1">
                      {PRESET_PROMPTS.map((p, i) => {
                        const c = pastelColors[i % pastelColors.length]
                        return (
                          <Button
                            key={p.label} type="button" variant="outline" size="sm"
                            disabled={isChatLoading || speechStatus === "recording" || speechStatus === "processing"}
                            onClick={() => sendMessage(p.text)}
                            className={`text-xs h-9 px-4 rounded-xl border ${c.bg} ${c.border} ${c.text} ${c.hover} disabled:opacity-50 transition-all`}
                          >
                            {p.label}
                          </Button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* 输入框 */}
                <div className="shrink-0 border-t border-gray-200 p-4 bg-gray-50/80">
                  {speechError && (
                    <div className="mb-2 text-xs text-red-600 flex items-center justify-between gap-2">
                      <span>{speechError}</span>
                      <Button variant="ghost" size="sm" className="h-6 px-1 text-red-600" onClick={() => setSpeechError(null)}>关闭</Button>
                    </div>
                  )}
                  <form onSubmit={handleSubmit}>
                    <div className="flex flex-col rounded-lg border border-gray-300 bg-white shadow-sm focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400/20 transition-all">
                      <Textarea
                        ref={textareaRef}
                        value={inputText}
                        onChange={(e) => setInputText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={selectedTweet ? "输入或语音...（Shift+Enter 换行）" : "请先点击左侧推文..."}
                        disabled={isChatLoading || !selectedTweet || speechStatus === "processing"}
                        className="block w-full min-h-[44px] max-h-[120px] text-sm resize-none pt-2.5 px-3 border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent placeholder:text-gray-400"
                        rows={1}
                      />
                      <div className="flex items-center justify-end gap-1.5 p-1.5 shrink-0">
                        <Button
                          type="button" size="icon" variant="ghost"
                          onClick={handleVoiceToggle}
                          disabled={isChatLoading || !selectedTweet || speechStatus === "processing"}
                          className="h-8 w-8 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 transition-colors"
                          title={speechStatus === "recording" ? "停止录音" : "语音输入"}
                        >
                          {speechStatus === "recording"
                            ? <StopCircle className="h-4 w-4 text-red-500" />
                            : <Mic className="h-4 w-4" />}
                        </Button>
                        <Button
                          type="submit" size="icon"
                          disabled={!inputText.trim() || isChatLoading || !selectedTweet}
                          className="h-8 w-8 bg-emerald-600 hover:bg-emerald-700 rounded-md disabled:opacity-50 transition-colors shadow-sm"
                        >
                          <Send className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          )}

          {/* ── 桌面端：悬浮打开按钮 ── */}
          {!isMobile && !effectiveChatOpen && (
            <div className="fixed right-0 z-[100] flex justify-end pointer-events-none top-1/2 -translate-y-1/2">
              <Button
                onClick={() => setIsChatOpen(true)}
                className="pointer-events-auto h-20 pl-5 pr-4 w-auto rounded-l-2xl rounded-r-none bg-gray-200/95 hover:bg-gray-300/95 text-gray-700 shadow-md border border-l border-gray-300/50 flex items-center justify-center gap-2 transition-all hover:shadow-lg active:scale-[0.98]"
                title="打开 AI 助手"
              >
                <Sparkles className="h-9 w-9 text-emerald-600" />
              </Button>
            </div>
          )}

          {/* ── 手机端：底部抽屉 ── */}
          {isMobile && (
            <div
              className="fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-2xl overflow-hidden flex flex-col"
              style={{
                height: sheetHeight,
                boxShadow: "0 -4px 32px rgba(0,0,0,0.14), 0 -1px 6px rgba(0,0,0,0.06)",
                transition: isDragging ? "none" : "height 0.32s cubic-bezier(0.32,0.72,0,1)",
              }}
            >
              {/* 拖拽手柄 */}
              <div
                className="shrink-0 pt-2.5 pb-1 flex justify-center touch-none select-none cursor-grab active:cursor-grabbing"
                onTouchStart={handleSheetDragStart}
                onTouchMove={handleSheetDragMove}
                onTouchEnd={handleSheetDragEnd}
              >
                <div className="w-9 h-1 bg-gray-300 rounded-full" />
              </div>

              {/* Half / Full 状态：完整 AI 聊天 */}
              <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

                  {/* AI 面板标题 */}
                  <div className="shrink-0 px-4 py-2 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Sparkles className="h-4 w-4 text-emerald-600 shrink-0" />
                      <h3 className="text-sm font-semibold text-gray-700">AI 解读助手</h3>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        type="button" variant="outline" size="sm"
                        onClick={() => { if (isSpeechEnabled) { whisperSpeechService.stopSpeaking(); setSpeechError(null) }; setIsSpeechEnabled(!isSpeechEnabled) }}
                        className={`h-8 px-2 border ${voiceColor.bg} ${voiceColor.border} ${voiceColor.text} ${voiceColor.hover}`}
                        title={isSpeechEnabled ? "关闭语音" : "开启语音"}
                      >
                        {isSpeechEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                      </Button>
                      {sheetState === "full" && (
                        <Button type="button" variant="ghost" size="icon"
                          onClick={() => setSheetState("half")}
                          className="h-10 w-10 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md touch-manipulation"
                          title="缩小"
                        >
                          <ChevronDown className="h-5 w-5" />
                        </Button>
                      )}
                      {sheetState === "half" && (
                        <Button type="button" variant="ghost" size="icon"
                          onClick={() => setSheetState("hidden")}
                          className="h-10 w-10 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md touch-manipulation"
                          title="收起"
                        >
                          <ChevronDown className="h-5 w-5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* 消息列表 */}
                  <div className="flex-1 overflow-y-auto p-4 space-y-4 hide-vertical-scrollbar" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
                    {!selectedTweet && (
                      <div className="flex flex-col items-center justify-center h-full text-center gap-3 py-8">
                        <Sparkles className="h-8 w-8 text-gray-200" />
                        <p className="text-sm font-medium text-gray-400">点击上方推文</p>
                        <p className="text-xs text-gray-300">AI 将为你解读该推文</p>
                      </div>
                    )}
                    {/* 推文上下文卡片：始终位于对话最顶部 */}
                    {selectedTweet && (
                      <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 mb-1">
                        <div className="flex items-center gap-2 mb-1.5">
                          {selectedTweet.author.profilePicture ? (
                            <img src={selectedTweet.author.profilePicture} alt={selectedTweet.author.name}
                              className="w-6 h-6 rounded-full object-cover shrink-0" />
                          ) : (
                            <div className="w-6 h-6 rounded-full bg-gray-200 shrink-0 flex items-center justify-center text-xs text-gray-500">
                              {selectedTweet.author.name?.[0]}
                            </div>
                          )}
                          <span className="text-xs font-semibold text-gray-800 truncate">{selectedTweet.author.name}</span>
                          <span className="text-xs text-gray-400 truncate">@{selectedTweet.author.userName}</span>
                        </div>
                        <p className="text-xs text-gray-700 leading-relaxed">{selectedTweet.text}</p>
                      </div>
                    )}
                    {selectedTweet && messages.length === 0 && (
                      <div className="text-center text-sm text-gray-500 mt-6 space-y-2">
                        <p className="font-medium">有什么问题想了解吗？</p>
                        <p className="text-xs text-gray-400">点击下方快捷按钮，或直接输入</p>
                      </div>
                    )}
                    {messages.map((msg, i) => (
                      <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
                        {msg.role === "user" && (
                          <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium bg-violet-500 text-white">我</div>
                        )}
                        <div className={`flex-1 min-w-0 text-sm leading-relaxed ${msg.role === "user" ? "text-right" : "text-gray-800"}`}>
                          {msg.role === "user" ? (
                            <div className="inline-block max-w-[85%] rounded-2xl bg-violet-50 border border-violet-100 px-4 py-2 text-gray-900 text-left">
                              {msg.content}
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <div className="rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 whitespace-pre-wrap">
                                {msg.content ? extractSpeakContent(msg.content) : (
                                  <span className="inline-flex gap-0.5 text-gray-400">
                                    <span className="animate-dot-flash-1">·</span>
                                    <span className="animate-dot-flash-2">·</span>
                                    <span className="animate-dot-flash-3">·</span>
                                  </span>
                                )}
                              </div>
                              {i === messages.length - 1 && speechStatus === "speaking" && (
                                <div className="flex items-center gap-2 text-xs text-emerald-600 pt-1">
                                  <span className="flex items-end gap-0.5 h-4">
                                    {[1,2,3,4].map((n) => (
                                      <span key={n} className={`w-1 bg-emerald-500 rounded-full origin-bottom animate-sound-wave animate-sound-wave-${n} ${n % 2 === 0 ? "h-4" : "h-3"} inline-block`} />
                                    ))}
                                  </span>
                                  <Volume2 className="h-3.5 w-3.5 shrink-0" />
                                  正在播放
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                    {isChatLoading && (
                      <div className="flex gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="inline-block rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 text-sm text-gray-500">
                            <span className="inline-flex gap-0.5">
                              <span className="animate-dot-flash-1">·</span>
                              <span className="animate-dot-flash-2">·</span>
                              <span className="animate-dot-flash-3">·</span>
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>

                  {/* 快捷提问 */}
                  {selectedTweet && (
                    <div className="shrink-0 px-4 py-2 border-t border-gray-100 bg-gray-50/80">
                      <div className="flex flex-wrap gap-x-3 gap-y-2 pt-1">
                        {PRESET_PROMPTS.map((p, i) => {
                          const c = pastelColors[i % pastelColors.length]
                          return (
                            <Button
                              key={p.label} type="button" variant="outline" size="sm"
                              disabled={isChatLoading || speechStatus === "recording" || speechStatus === "processing"}
                              onClick={() => sendMessage(p.text)}
                              className={`text-xs h-9 px-4 rounded-xl border ${c.bg} ${c.border} ${c.text} ${c.hover} disabled:opacity-50 transition-all`}
                            >
                              {p.label}
                            </Button>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {/* 输入框 */}
                  <div className="shrink-0 border-t border-gray-200 p-3 bg-gray-50/80">
                    {speechError && (
                      <div className="mb-2 text-xs text-red-600 flex items-center justify-between gap-2">
                        <span>{speechError}</span>
                        <Button variant="ghost" size="sm" className="h-6 px-1 text-red-600" onClick={() => setSpeechError(null)}>关闭</Button>
                      </div>
                    )}
                    <form onSubmit={handleSubmit}>
                      <div className="flex flex-col rounded-lg border border-gray-300 bg-white shadow-sm focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400/20 transition-all">
                        <Textarea
                          ref={textareaRef}
                          value={inputText}
                          onChange={(e) => setInputText(e.target.value)}
                          onKeyDown={handleKeyDown}
                          placeholder={selectedTweet ? "输入或语音..." : "请先点击推文..."}
                          disabled={isChatLoading || !selectedTweet || speechStatus === "processing"}
                          className="block w-full min-h-[44px] max-h-[120px] text-sm resize-none pt-2.5 px-3 border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent placeholder:text-gray-400"
                          rows={1}
                        />
                        <div className="flex items-center justify-end gap-1.5 p-1.5 shrink-0">
                          <Button
                            type="button" size="icon" variant="ghost"
                            onClick={handleVoiceToggle}
                            disabled={isChatLoading || !selectedTweet || speechStatus === "processing"}
                            className="h-8 w-8 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 transition-colors"
                            title={speechStatus === "recording" ? "停止录音" : "语音输入"}
                          >
                            {speechStatus === "recording"
                              ? <StopCircle className="h-4 w-4 text-red-500" />
                              : <Mic className="h-4 w-4" />}
                          </Button>
                          <Button
                            type="submit" size="icon"
                            disabled={!inputText.trim() || isChatLoading || !selectedTweet}
                            className="h-8 w-8 bg-emerald-600 hover:bg-emerald-700 rounded-md disabled:opacity-50 transition-colors shadow-sm"
                          >
                            <Send className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </form>
                  </div>
                </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 手机端：重新打开 AI 的悬浮按钮（有已选推文但抽屉隐藏时显示） ── */}
      {isMobile && sheetState === "hidden" && selectedTweet && (
        <button
          className="fixed bottom-6 right-4 z-50 w-12 h-12 rounded-full bg-emerald-600 shadow-lg flex items-center justify-center touch-manipulation active:scale-95 transition-transform"
          style={{ bottom: "calc(1.5rem + env(safe-area-inset-bottom, 0px))" }}
          onClick={() => setSheetState("half")}
          aria-label="打开 AI 助手"
        >
          <Sparkles className="h-5 w-5 text-white" />
        </button>
      )}

      {/* ── 手机端「查词」确认按钮（选中文字后出现） ── */}
      {pendingLookup && (
        <div
          data-pending-lookup
          className="fixed z-[200] pointer-events-auto"
          style={{
            left: Math.max(8, Math.min(pendingLookup.anchorX - 28, (typeof window !== "undefined" ? window.innerWidth : 375) - 72)),
            top: Math.min(
              pendingLookup.anchorY + 8,
              (typeof window !== "undefined" ? window.innerHeight : 800) - 48
            ),
          }}
        >
          <button
            className="px-3.5 py-1.5 bg-gray-900 text-white text-xs font-semibold rounded-full shadow-xl whitespace-nowrap touch-manipulation active:scale-95 transition-transform"
            onClick={() => {
              const { text, anchorX, anchorY, tweet } = pendingLookup
              setPendingLookup(null)
              window.getSelection()?.removeAllRanges()
              handleTextSelect(text, anchorX, anchorY, tweet)
            }}
          >
            查词
          </button>
        </div>
      )}

      {/* ── 查词气泡 ── */}
      {lookupPopup && (
        <LookupPopupCard
          text={lookupPopup.text}
          anchorX={lookupPopup.anchorX}
          anchorY={lookupPopup.anchorY}
          result={lookupResult}
          loading={isLookupLoading}
          onClose={() => setLookupPopup(null)}
          onAskAI={() => {
            const { tweet, text } = lookupPopup
            setLookupPopup(null)
            if (selectedTweet?.id !== tweet.id) { setSelectedTweet(tweet); setMessages([]) }
            setInputText(`请解释「${text}」在这条推文中的含义`)
            if (isMobile) {
              setSheetState("half")
              setTimeout(() => textareaRef.current?.focus(), 100)
            } else {
              setIsChatOpen(true)
              setTimeout(() => textareaRef.current?.focus(), 100)
            }
          }}
        />
      )}
    </div>
  )
}

// ─── TweetCard 组件 ────────────────────────────────────────────────────────────
function TweetCard({
  tweet, index, isSelected, onClick, onTextSelect, onAiClick, isMobile,
}: {
  tweet: Tweet; index: number; isSelected: boolean; onClick: () => void
  onTextSelect?: (text: string, anchorX: number, anchorY: number) => void
  onAiClick: () => void
  isMobile: boolean
}) {
  const readSelection = () => {
    if (!onTextSelect) return
    const sel = window.getSelection()
    const text = sel?.toString().trim()
    if (!text || text.length > 200) return
    try {
      const rect = sel!.getRangeAt(0).getBoundingClientRect()
      onTextSelect(text, rect.left + rect.width / 2, rect.bottom)
      // 不在此处清除 selection，保持高亮让用户看到选中内容
    } catch {}
  }

  // 桌面端：mouseup 直接读取 selection
  const handleMouseUp = () => readSelection()

  // 手机端：touchend 后浏览器需要一帧才能将长按 selection 提交给 window.getSelection()
  const handleTouchEnd = () => {
    if (!isMobile) return
    requestAnimationFrame(() => readSelection())
  }

  return (
    <article
      className={`px-4 py-4 transition-colors tweet-card ${
        isSelected
          ? "bg-blue-50/90 border-l-[3px] border-blue-400"
          : "bg-white/75 hover:bg-white/90"
      } ${isMobile ? "" : "cursor-pointer"}`}
      style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
      onClick={() => {
        if (window.getSelection()?.toString().trim()) return
        onClick()
      }}
    >
      <div className="flex gap-3">
        <div className="shrink-0">
          {tweet.author.profilePicture ? (
            <Image
              src={tweet.author.profilePicture}
              alt={tweet.author.name}
              width={40} height={40}
              className="w-10 h-10 rounded-full object-cover"
              unoptimized
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-bold">
              {tweet.author.name?.[0] ?? "?"}
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="font-semibold text-sm text-gray-900 truncate">{tweet.author.name}</span>
            <span className="text-xs text-gray-400 shrink-0">@{tweet.author.userName}</span>
            <span className="text-xs text-gray-300 shrink-0">·</span>
            <span className="text-xs text-gray-400 shrink-0">{formatRelativeTime(tweet.createdAt)}</span>
          </div>
          <p
            className="mt-1.5 text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-words line-clamp-6 select-text"
            onMouseUp={handleMouseUp}
            onTouchEnd={handleTouchEnd}
          >
            {smartCase(tweet.text)}
          </p>
          {tweet.textZh && (
            <p
              className="mt-1 text-sm text-gray-500 leading-relaxed whitespace-pre-wrap break-words line-clamp-4 select-text"
              onMouseUp={handleMouseUp}
              onTouchEnd={handleTouchEnd}
            >
              {tweet.textZh}
            </p>
          )}
          {tweet.media.length > 0 && tweet.media[0].type === "photo" && tweet.media[0].url && (
            <div className="mt-2 rounded-xl overflow-hidden border border-gray-200/80">
              <img src={tweet.media[0].url} alt="media" className="w-full max-h-48 object-cover" loading="lazy" />
            </div>
          )}
          <div className="mt-2.5 flex items-center gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" />{formatCount(tweet.likeCount)}</span>
            <span className="flex items-center gap-1"><Repeat2 className="h-3.5 w-3.5" />{formatCount(tweet.retweetCount)}</span>
            <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" />{formatCount(tweet.replyCount)}</span>
            {tweet.viewCount > 0 && (
              <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />{formatCount(tweet.viewCount)}</span>
            )}
            <button
              className="ml-auto p-1.5 rounded-full text-emerald-600 hover:bg-emerald-50 active:scale-95 touch-manipulation transition-transform"
              onClick={(e) => { e.stopPropagation(); onAiClick() }}
              aria-label="AI 解读"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

// ─── LookupPopupCard 组件 ───────────────────────────────────────────────────────
function LookupPopupCard({
  text, anchorX, anchorY, result, loading, onClose, onAskAI,
}: {
  text: string; anchorX: number; anchorY: number
  result: LookupResult | null; loading: boolean
  onClose: () => void; onAskAI: () => void
}) {
  const POPUP_W = 340
  const GAP = 10
  const isMobilePopup = typeof window !== "undefined" && window.innerWidth < 768

  const left = typeof window !== "undefined"
    ? Math.max(8, Math.min(anchorX - POPUP_W / 2, window.innerWidth - POPUP_W - 8))
    : anchorX

  const style: React.CSSProperties = isMobilePopup
    ? { position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 9999 }
    : anchorY > 180
      ? { position: "fixed", bottom: window.innerHeight - anchorY + GAP, left, width: POPUP_W, zIndex: 9999 }
      : { position: "fixed", top: anchorY + GAP + 16, left, width: POPUP_W, zIndex: 9999 }

  return (
    <div
      data-lookup-popup
      style={style}
      className={`bg-white shadow-xl border border-gray-200 overflow-hidden ${isMobilePopup ? "rounded-t-2xl max-h-[80vh] overflow-y-auto" : "rounded-2xl"}`}
    >
      {/* 标题行 */}
      <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-2 border-b border-gray-100">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-semibold text-gray-900 text-sm">{text}</span>
            {result?.phonetic && (
              <span className="text-xs text-violet-500 font-mono">{result.phonetic}</span>
            )}
            {result?.partOfSpeech && (
              <span className="text-xs text-amber-600 italic">{result.partOfSpeech}</span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-600 mt-0.5">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 内容区 */}
      <div className="px-4 py-3 space-y-3 min-h-[60px]">
        {loading ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <div className="w-4 h-4 border-2 border-gray-200 border-t-violet-400 rounded-full animate-spin shrink-0" />
            查询中...
          </div>
        ) : result ? (
          <>
            {/* 中文释义 */}
            {result.translation && (
              <p className="text-sm font-bold text-gray-900 leading-snug">{result.translation}</p>
            )}

            {/* 详细释义（单词）或 词义拆解（短语）*/}
            {(result.definition || result.breakdown) && (
              <div className="border-t border-gray-100 pt-2">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">
                  {result.breakdown ? "词义拆解" : "释义"}
                </p>
                <p className="text-xs text-gray-700 leading-relaxed">
                  {result.breakdown ?? result.definition}
                </p>
              </div>
            )}

            {/* 语法说明 */}
            {result.grammar && (
              <div className="border-t border-gray-100 pt-2">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">语法说明</p>
                <p className="text-xs text-gray-700 leading-relaxed">{result.grammar}</p>
              </div>
            )}

            {/* 例句 */}
            {result.example && (
              <div className="border-t border-gray-100 pt-2">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1">例句</p>
                <p className="text-xs text-gray-800 italic leading-relaxed">{result.example}</p>
                {result.exampleZh && (
                  <p className="text-xs text-gray-500 leading-relaxed mt-0.5">{result.exampleZh}</p>
                )}
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* 操作按钮 */}
      <div className="px-4 pb-4 pt-1 flex gap-2 border-t border-gray-100">
        <button
          onClick={() => { try { navigator.clipboard.writeText(text) } catch {} onClose() }}
          className="flex-1 text-xs px-3 py-1.5 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-700 transition-colors"
        >
          复制
        </button>
        <button
          onClick={onAskAI}
          className="flex-1 text-xs px-3 py-1.5 rounded-full bg-violet-100 hover:bg-violet-200 text-violet-700 transition-colors flex items-center justify-center gap-1"
        >
          <Sparkles className="h-3 w-3" />
          在AI中讨论
        </button>
      </div>
    </div>
  )
}
