"use client"

import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react"
import Image from "next/image"

import { AiPanel, type AiMessage } from "@/components/ai-panel"
import { SelectionActionMenu } from "@/components/selection-action-menu"
import { ACCOUNTS } from "@/config/accounts"
import type { Tweet } from "@/lib/twitter"
import { formatRelativeTime, formatCount } from "@/lib/twitter"
import { Heart, Repeat2, MessageCircle, Eye, RefreshCw, ChevronDown, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { whisperSpeechService, type SpeechStatus } from "@/app/conversation/whisper-speech-service"

// ─── 常量 ─────────────────────────────────────────────────────────────────────
const MIN_CHAT_WIDTH = 280
const MAX_CHAT_WIDTH_PERCENT = 70
const DEFAULT_CHAT_WIDTH = 420

const FAB_SIZE = 48
const FAB_MARGIN = 8
const FAB_DEFAULT_RIGHT = 16
const FAB_DEFAULT_BOTTOM = 24
const FAB_CLICK_THRESHOLD = 8
const FAB_STORAGE_KEY = "tweet-home-fab-position"

// ─── 类型 ─────────────────────────────────────────────────────────────────────
type SheetState = "hidden" | "half" | "full"
type TweetCache = Record<string, { tweets: Tweet[]; hasMore: boolean; nextCursor?: string; loadedAt: number }>
type SelectionMode = "wordOrPhrase" | "sentenceOrPassage"
type SelectionSource = "tweet" | "assistantReply"
type SelectionActionId = "lookup" | "pattern" | "readAloud" | "followUp" | "explainReply" | "translateReply" | "quoteReply"
type SelectionAction = { id: SelectionActionId; label: string; buildPrompt?: (text: string) => string; buildDraft?: () => string }
type SelectionMenuState = {
  text: string
  anchorX: number
  anchorY: number
  tweet: Tweet
  mode: SelectionMode
  source: SelectionSource
  messageIndex?: number
  fullMessageContent?: string
}
type QuotedSelectionState = {
  text: string
  sourceRole: "assistant"
  messageIndex: number
  fullMessageContent: string
}

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

function isWordOrPhraseLookup(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ")
  if (!normalized) return true

  const wordCount = normalized.split(" ").length
  const hasStrongSentencePunctuation = /[.!?;:]/.test(normalized)
  const hasClauseSignal = /,|\bthat\b|\bwhich\b|\bwho\b|\bwhen\b|\bwhile\b|\bif\b|\bbecause\b|\bbut\b|\band\b/i.test(normalized)

  return wordCount <= 4 && !hasStrongSentencePunctuation && !hasClauseSignal
}

function getSelectionMode(text: string): SelectionMode {
  return isWordOrPhraseLookup(text) ? "wordOrPhrase" : "sentenceOrPassage"
}

function buildLookupPrompt(text: string): string {
  if (getSelectionMode(text) === "wordOrPhrase") {
    return `请解释我在这条推文里选中的这个英文单词或短语：「${text}」。

这次请使用“英语词典讲解”风格，目标是帮助中文用户真正学会它，而不是只看中文翻译。

请严格按这个顺序组织，尽量简洁：
1. 原词 / 原短语：原样写出
2. 语境义：它在这条推文里的自然含义
3. 用法提示：说明它在这里的语气、搭配、感情色彩、隐含意思，或为什么这样说
4. 常见误区：如果容易按字面误解，或容易和别的表达混淆，顺手提醒一句
5. 可替换表达：给 1 到 2 个这个语境里可替换的英文表达
6. 英文例句：给 1 个简短自然的英文例句，并附中文翻译

补充要求：
- 回答主体用中文，但保留关键英文表达
- 如果这是俚语、缩写、梗、固定搭配或带语气的说法，要直接点明
- 不要展开成长篇文章，像老师讲词汇重点
- 不要脱离当前推文语境，不要只给词典式死定义`
  }

  return `请解释我在这条推文里选中的这句或这段英文：「${text}」。

这次请使用“英语精读拆解”风格，目标是帮助中文用户真正读懂句子结构、语气和表达方式，而不是只给整句翻译。

请严格按这个顺序组织，尽量简洁：
1. 原句 / 原文：原样写出
2. 整体句意：先用自然中文说清整句在这条推文里的意思
3. 精读拆解：按意群或短语分块解释，每一块都说明它在这里表达什么
4. 表达重点：指出这句里最值得学习的 1 到 3 个表达、搭配或句式
5. 语气 / 弦外之音：如果有强调、调侃、反讽、省略、口语感、网络语气，也说明一下
6. 学习收获：最后用一句话总结“这句英文最值得记住的地方”

补充要求：
- 回答主体用中文，但保留关键英文表达
- 不要逐词硬译，要优先解释真实语境
- 如果字面义和真实语境义不同，要点明
- 不要长篇大论，像老师带着学生做一句精读
- 不要脱离当前推文语境`
}

function buildPatternPrompt(text: string): string {
  if (getSelectionMode(text) === "wordOrPhrase") {
    return `请讲解我在这条推文里选中的这个英文短语或表达：「${text}」。

这次请用“表达 / 句型讲解”的方式回答，重点帮助中文用户学会这个表达怎么用，而不是只解释字面意思。

请按这个顺序组织：
1. 原表达：原样写出
2. 这类表达在这里是什么意思
3. 它常见的搭配或句型位置
4. 使用场景：通常在什么语气或语境里会这样说
5. 可替换说法：给 1 到 2 个自然替换
6. 英文例句：给 1 个短例句，并附中文翻译

补充要求：
- 回答主体用中文，但保留关键英文
- 如果这是固定搭配、俚语、网络表达或口语说法，要直接点明
- 不要讲成语法教材，要更像老师讲“这个表达怎么用”
- 不要脱离当前推文语境`
  }

  return `请讲解我在这条推文里选中的这个英文句子或片段的句型与表达方式：「${text}」。

这次请用“句型讲解”风格回答，重点帮助中文用户理解这句话是怎么组织出来的、为什么这样说。

请按这个顺序组织：
1. 原句 / 原文：原样写出
2. 句型骨架：用最简洁的话概括这句话的结构
3. 关键表达块：拆出 2 到 4 个关键部分，说明各自作用
4. 为什么这么说：解释这种表达在推文语境里的效果和语气
5. 可迁移句型：总结一个值得模仿的表达模板
6. 仿写例句：给 1 个可模仿的英文例句，并附中文翻译

补充要求：
- 回答主体用中文，但保留关键英文
- 不要只做翻译，要解释结构和表达效果
- 不要脱离当前推文语境
- 保持简洁，像精讲一个句型`
}

function buildAssistantDraft(actionId: SelectionActionId): string {
  switch (actionId) {
    case "followUp":
      return "请基于我引用的这段回复，继续展开说明："
    case "explainReply":
      return "请结合上下文，详细解释我引用的这段回复，尤其想知道："
    case "translateReply":
      return "请把我引用的这段回复翻译成更自然易懂的中文，并顺手解释关键表达。"
    default:
      return ""
  }
}

function mergeDraftText(currentText: string, nextText: string): string {
  const trimmedCurrent = currentText.trim()
  const trimmedNext = nextText.trim()

  if (!trimmedNext) return currentText
  if (!trimmedCurrent) return nextText
  if (trimmedCurrent.includes(trimmedNext)) return currentText

  return `${trimmedCurrent}\n\n${trimmedNext}`
}

function buildQuotedFollowUpMessage(text: string, quotedSelection: QuotedSelectionState): string {
  const question = text.trim()
  const fullReply = quotedSelection.fullMessageContent.trim()
  const excerpt = quotedSelection.text.trim()
  const replyContext = fullReply && fullReply !== excerpt
    ? `\n\n这条回复的完整内容如下：\n${fullReply.slice(0, 1200)}`
    : ""

  return `以下内容来自你之前的一条回复，请结合原回答的上下文继续回答。

我选中的片段是：
「${excerpt}」

这段片段来自 assistant 的第 ${quotedSelection.messageIndex + 1} 条回复。${replyContext}

我现在想继续追问：
${question}`
}

const SELECTION_ACTIONS: Record<SelectionActionId, SelectionAction> = {
  lookup: { id: "lookup", label: "查词", buildPrompt: buildLookupPrompt },
  pattern: { id: "pattern", label: "句型讲解", buildPrompt: buildPatternPrompt },
  followUp: { id: "followUp", label: "追问这段", buildDraft: () => buildAssistantDraft("followUp") },
  explainReply: { id: "explainReply", label: "解释这段", buildDraft: () => buildAssistantDraft("explainReply") },
  translateReply: { id: "translateReply", label: "翻译这段", buildDraft: () => buildAssistantDraft("translateReply") },
  quoteReply: { id: "quoteReply", label: "引用到输入框", buildDraft: () => "" },
  readAloud: { id: "readAloud", label: "朗读" },
}

const PRIMARY_TWEET_SELECTION_ACTIONS: Record<SelectionMode, SelectionActionId[]> = {
  wordOrPhrase: ["lookup", "pattern", "readAloud"],
  sentenceOrPassage: ["lookup", "pattern", "readAloud"],
}

const PRIMARY_ASSISTANT_SELECTION_ACTIONS: SelectionActionId[] = ["followUp", "explainReply", "translateReply", "quoteReply", "readAloud"]

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
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [inputText, setInputText] = useState("")
  const [quotedSelection, setQuotedSelection] = useState<QuotedSelectionState | null>(null)
  const [isChatLoading, setIsChatLoading] = useState(false)
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle")
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(true)

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

  // 手机端悬浮 AI 按钮位置（可拖动，不超出屏幕）
  const [fabRight, setFabRight] = useState(FAB_DEFAULT_RIGHT)
  const [fabBottom, setFabBottom] = useState(FAB_DEFAULT_BOTTOM)
  const fabDragStartRef = useRef<{ right: number; bottom: number; clientX: number; clientY: number; touchId?: number } | null>(null)
  const fabHasDraggedRef = useRef(false)
  const fabRightRef = useRef(FAB_DEFAULT_RIGHT)
  const fabBottomRef = useRef(FAB_DEFAULT_BOTTOM)
  fabRightRef.current = fabRight
  fabBottomRef.current = fabBottom

  // 选区动作菜单：保存选中文本、锚点和菜单展开状态
  const [selectionMenu, setSelectionMenu] = useState<SelectionMenuState | null>(null)
  const [pendingSelectionActionId, setPendingSelectionActionId] = useState<SelectionActionId | null>(null)

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
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
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
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
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

  // ── 手机端悬浮按钮：可拖动、不超出屏幕 ──
  const clampFabPosition = useCallback((right: number, bottom: number) => {
    if (typeof window === "undefined") return { right: FAB_DEFAULT_RIGHT, bottom: FAB_DEFAULT_BOTTOM }
    const maxRight = window.innerWidth - FAB_SIZE - FAB_MARGIN
    const maxBottom = window.innerHeight - FAB_SIZE - FAB_MARGIN
    return {
      right: Math.max(FAB_MARGIN, Math.min(right, maxRight)),
      bottom: Math.max(FAB_MARGIN, Math.min(bottom, maxBottom)),
    }
  }, [])

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return
    try {
      const raw = localStorage.getItem(FAB_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { right?: number; bottom?: number }
        const r = typeof parsed?.right === "number" ? parsed.right : FAB_DEFAULT_RIGHT
        const b = typeof parsed?.bottom === "number" ? parsed.bottom : FAB_DEFAULT_BOTTOM
        const { right, bottom } = clampFabPosition(r, b)
        setFabRight(right)
        setFabBottom(bottom)
      }
    } catch {}
  }, [mounted, clampFabPosition])

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return
    const onResize = () => {
      const { right, bottom } = clampFabPosition(fabRightRef.current, fabBottomRef.current)
      setFabRight(right)
      setFabBottom(bottom)
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [mounted, clampFabPosition])

  useEffect(() => {
    if (!mounted || typeof window === "undefined") return
    localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({ right: fabRight, bottom: fabBottom }))
  }, [mounted, fabRight, fabBottom])

  const handleFabPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    fabDragStartRef.current = { right: fabRight, bottom: fabBottom, clientX: e.clientX, clientY: e.clientY }
    fabHasDraggedRef.current = false
    const onMove = (e: PointerEvent) => {
      e.preventDefault()
      const start = fabDragStartRef.current
      if (!start) return
      const deltaX = e.clientX - start.clientX
      const deltaY = e.clientY - start.clientY
      if (!fabHasDraggedRef.current && (Math.abs(deltaX) > FAB_CLICK_THRESHOLD || Math.abs(deltaY) > FAB_CLICK_THRESHOLD)) {
        fabHasDraggedRef.current = true
      }
      if (fabHasDraggedRef.current && typeof window !== "undefined") {
        const newRight = start.right - deltaX
        const newBottom = start.bottom - deltaY
        const { right, bottom } = clampFabPosition(newRight, newBottom)
        setFabRight(right)
        setFabBottom(bottom)
      }
    }
    const onUp = () => {
      if (!fabHasDraggedRef.current) setSheetState("half")
      fabDragStartRef.current = null
      document.removeEventListener("pointermove", onMove, true)
      document.removeEventListener("pointerup", onUp, true)
      document.removeEventListener("pointercancel", onUp, true)
    }
    document.addEventListener("pointermove", onMove, { capture: true, passive: false })
    document.addEventListener("pointerup", onUp, true)
    document.addEventListener("pointercancel", onUp, true)
  }, [fabRight, fabBottom, clampFabPosition])

  const handleFabTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    if (!touch) return
    fabDragStartRef.current = {
      right: fabRight,
      bottom: fabBottom,
      clientX: touch.clientX,
      clientY: touch.clientY,
      touchId: touch.identifier,
    }
    fabHasDraggedRef.current = false
    const onTouchMove = (ev: TouchEvent) => {
      const start = fabDragStartRef.current
      if (!start || start.touchId === undefined) return
      const t = Array.from(ev.touches).find((x) => x.identifier === start.touchId)
      if (!t) return
      ev.preventDefault()
      const deltaX = t.clientX - start.clientX
      const deltaY = t.clientY - start.clientY
      if (!fabHasDraggedRef.current && (Math.abs(deltaX) > FAB_CLICK_THRESHOLD || Math.abs(deltaY) > FAB_CLICK_THRESHOLD)) {
        fabHasDraggedRef.current = true
      }
      if (fabHasDraggedRef.current && typeof window !== "undefined") {
        const newRight = start.right - deltaX
        const newBottom = start.bottom - deltaY
        const { right, bottom } = clampFabPosition(newRight, newBottom)
        setFabRight(right)
        setFabBottom(bottom)
      }
    }
    const onTouchEnd = () => {
      if (!fabHasDraggedRef.current) setSheetState("half")
      fabDragStartRef.current = null
      document.removeEventListener("touchmove", onTouchMove, { capture: true })
      document.removeEventListener("touchend", onTouchEnd, { capture: true })
      document.removeEventListener("touchcancel", onTouchEnd, { capture: true })
    }
    document.addEventListener("touchmove", onTouchMove, { capture: true, passive: false })
    document.addEventListener("touchend", onTouchEnd, { capture: true })
    document.addEventListener("touchcancel", onTouchEnd, { capture: true })
  }, [fabRight, fabBottom, clampFabPosition])

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
  const sendMessage = useCallback(async (
    text: string,
    options?: { tweetOverride?: Tweet; includeQuotedSelection?: boolean },
  ) => {
    const targetTweet = options?.tweetOverride ?? selectedTweet
    if (!text.trim() || isChatLoading || !targetTweet) return

    const shouldResetMessages = selectedTweet?.id !== targetTweet.id
    const baseMessages = shouldResetMessages ? [] : messages
    const trimmedText = text.trim()
    const activeQuotedSelection = options?.includeQuotedSelection === false || shouldResetMessages
      ? null
      : quotedSelection
    const requestText = activeQuotedSelection
      ? buildQuotedFollowUpMessage(trimmedText, activeQuotedSelection)
      : trimmedText
    const userMsg: AiMessage = {
      role: "user",
      content: trimmedText,
      ...(activeQuotedSelection && { quoted: { text: activeQuotedSelection.text } }),
    }

    if (shouldResetMessages) setSelectedTweet(targetTweet)
    setMessages([...baseMessages, userMsg])
    setInputText("")
    setQuotedSelection(null)
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
        body: JSON.stringify({
          messages: [...baseMessages, { role: "user", content: requestText }],
          sceneMeta: buildSceneMeta(targetTweet),
        }),
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
    } catch { setSpeechError("对话请求失败，请稍后重试") }
    finally { setIsChatLoading(false) }
  }, [isChatLoading, selectedTweet, messages, quotedSelection, isMobile, sheetState])

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

  const handleSpeechToggle = () => {
    // 语音默认常开，保留空实现以防有地方仍引用
  }

  const closeSelectionMenu = useCallback((clearSelection = false) => {
    setSelectionMenu(null)
    setPendingSelectionActionId(null)
    if (clearSelection) window.getSelection()?.removeAllRanges()
  }, [])

  const openChatForSelection = useCallback((text: string, tweet: Tweet) => {
    if (isMobile) setSheetState("half")
    else if (!effectiveChatOpen) setIsChatOpen(true)
    setQuotedSelection(null)
    return sendMessage(text, { tweetOverride: tweet, includeQuotedSelection: false })
  }, [effectiveChatOpen, isMobile, sendMessage])

  const focusChatInput = useCallback(() => {
    if (isMobile) setSheetState("half")
    else if (!effectiveChatOpen) setIsChatOpen(true)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [effectiveChatOpen, isMobile])

  const handleSelectionAction = useCallback(async (actionId: SelectionActionId, selection: SelectionMenuState) => {
    const { text, tweet } = selection

    if (actionId === "readAloud") {
      setSpeechError(null)
      setPendingSelectionActionId("readAloud")
      try {
        await whisperSpeechService.speak(text)
      } finally {
        setPendingSelectionActionId((current) => current === "readAloud" ? null : current)
      }
      return
    }

    if (selection.source === "assistantReply") {
      setQuotedSelection({
        text,
        sourceRole: "assistant",
        messageIndex: selection.messageIndex ?? messages.length - 1,
        fullMessageContent: selection.fullMessageContent ?? text,
      })
      setInputText((current) => mergeDraftText(current, SELECTION_ACTIONS[actionId].buildDraft?.() ?? ""))
      closeSelectionMenu(true)
      focusChatInput()
      return
    }

    const prompt = SELECTION_ACTIONS[actionId].buildPrompt?.(text)
    if (!prompt) return
    closeSelectionMenu(true)
    await openChatForSelection(prompt, tweet)
  }, [closeSelectionMenu, focusChatInput, messages.length, openChatForSelection])

  const handleAssistantTextSelect = useCallback((selection: {
    text: string
    anchorX: number
    anchorY: number
    messageIndex: number
    fullMessageContent: string
  }) => {
    if (!selectedTweet) return
    setPendingSelectionActionId(null)
    setSelectionMenu({
      text: selection.text,
      anchorX: selection.anchorX,
      anchorY: selection.anchorY,
      tweet: selectedTweet,
      mode: getSelectionMode(selection.text),
      source: "assistantReply",
      messageIndex: selection.messageIndex,
      fullMessageContent: selection.fullMessageContent,
    })
  }, [selectedTweet])

  // 点击菜单外部时关闭选区菜单
  // 只监听 mousedown（不监听 touchstart），避免用户拖动选区手柄时误触发关闭
  useEffect(() => {
    if (!selectionMenu) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest("[data-selection-action-menu]")) {
        closeSelectionMenu(true)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [selectionMenu, closeSelectionMenu])

  // selectionchange：用户拖动手柄扩大/缩小选区时，只更新文本（不更新位置，避免菜单跳动）
  const selectionMenuRef = useRef(selectionMenu)
  selectionMenuRef.current = selectionMenu
  useEffect(() => {
    const handleSelectionChange = () => {
      if (!selectionMenuRef.current) return
      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!text) {
        closeSelectionMenu()
        return
      }
      // 只更新 text，菜单位置保持初始 readSelection 时的 rect.bottom
      setSelectionMenu((prev) => prev ? {
        ...prev,
        text,
        mode: getSelectionMode(text),
      } : null)
    }
    document.addEventListener("selectionchange", handleSelectionChange)
    return () => document.removeEventListener("selectionchange", handleSelectionChange)
  }, [closeSelectionMenu])

  // 选中推文 + 打开 AI（推文分析按钮专用）
  const handleOpenAI = (tweet: Tweet) => {
    if (selectedTweet?.id !== tweet.id) {
      setSelectedTweet(tweet)
      setMessages([])
      setQuotedSelection(null)
    }
    if (isMobile) setSheetState("half")
    else if (!effectiveChatOpen) setIsChatOpen(true)
  }

  const noTransition = !allowChatTransition || isResizing || justRestoredOpenRef.current
  const primarySelectionActions = selectionMenu
    ? (
      selectionMenu.source === "assistantReply"
        ? PRIMARY_ASSISTANT_SELECTION_ACTIONS
        : PRIMARY_TWEET_SELECTION_ACTIONS[selectionMenu.mode]
    ).map((id) => SELECTION_ACTIONS[id])
    : []

  return (
    <div
      className="flex flex-col overflow-hidden relative mobile-bg-scroll bg-fixed w-full h-[var(--app-height)]"
      style={{
        background: "linear-gradient(135deg, #dce8f0 0%, #ede8e0 40%, #e4ece6 100%)",
      }}
    >
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] pointer-events-none z-0" />

      {/* ── Header：始终流式布局，safe-area-top 保证刘海屏正常 ── */}
      <header className="relative z-10 shrink-0 bg-white/80 border-b border-gray-200 shadow-sm backdrop-blur-sm pt-[env(safe-area-inset-top)]">
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

      {/* ── 主体：推文列表 + AI 面板，flex-1 填满 header 下方全部空间 ── */}
      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden">

        {/* 左侧：推文列表 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden min-w-0">
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
                      onAiClick={() => handleOpenAI(tweet)}
                      onTextSelect={(text, ax, ay) => {
                        setPendingSelectionActionId(null)
                        setSelectionMenu({
                          text,
                          anchorX: ax,
                          anchorY: ay,
                          tweet,
                          mode: getSelectionMode(text),
                          source: "tweet",
                        })
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

                {/* 移动端仅用上方 paddingBottom 预留安全区，不再加 spacer 避免双重留白 */}
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
            <AiPanel
              variant="desktop"
              selectedTweet={selectedTweet}
              messages={messages}
              inputText={inputText}
              quotedSelection={quotedSelection}
              isChatLoading={isChatLoading}
              speechStatus={speechStatus}
              speechError={speechError}
              onClose={() => setIsChatOpen(false)}
              onSendPreset={(text) => sendMessage(text, { includeQuotedSelection: false })}
              onInputChange={(value) => setInputText(value)}
              onAssistantTextSelect={handleAssistantTextSelect}
              onClearQuotedSelection={() => setQuotedSelection(null)}
              onSubmit={handleSubmit}
              onKeyDown={handleKeyDown}
              onVoiceToggle={handleVoiceToggle}
              onDismissSpeechError={() => setSpeechError(null)}
              messagesEndRef={messagesEndRef}
              textareaRef={textareaRef}
              formatTweetText={smartCase}
              renderAssistantContent={extractSpeakContent}
              width={mounted ? chatWidth : DEFAULT_CHAT_WIDTH}
              minWidth={mounted ? MIN_CHAT_WIDTH : DEFAULT_CHAT_WIDTH}
              isOpen={effectiveChatOpen}
              noTransition={noTransition}
            />
          )}

          {/* ── 桌面端：悬浮打开按钮 ── */}
          {mounted && !isMobile && !effectiveChatOpen && (
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
            <AiPanel
              variant="mobile"
              selectedTweet={selectedTweet}
              messages={messages}
              inputText={inputText}
              quotedSelection={quotedSelection}
              isChatLoading={isChatLoading}
              speechStatus={speechStatus}
              speechError={speechError}
              onClose={() => setSheetState(sheetState === "full" ? "half" : "hidden")}
              onSendPreset={(text) => sendMessage(text, { includeQuotedSelection: false })}
              onInputChange={(value) => setInputText(value)}
              onAssistantTextSelect={handleAssistantTextSelect}
              onClearQuotedSelection={() => setQuotedSelection(null)}
              onSubmit={handleSubmit}
              onKeyDown={handleKeyDown}
              onVoiceToggle={handleVoiceToggle}
              onDismissSpeechError={() => setSpeechError(null)}
              messagesEndRef={messagesEndRef}
              textareaRef={textareaRef}
              formatTweetText={smartCase}
              renderAssistantContent={extractSpeakContent}
              sheetHeight={sheetHeight}
              isDragging={isDragging}
              sheetState={sheetState}
              onHandleTouchStart={handleSheetDragStart}
              onHandleTouchMove={handleSheetDragMove}
              onHandleTouchEnd={handleSheetDragEnd}
            />
          )}
        </div>

      {/* ── 手机端：重新打开 AI 的悬浮按钮（可拖动，不超出屏幕） ── */}
      {isMobile && sheetState === "hidden" && (
        <button
          type="button"
          className="fixed z-50 w-12 h-12 rounded-full bg-emerald-600 shadow-lg flex items-center justify-center touch-manipulation active:scale-95 transition-transform"
          style={{
            right: fabRight,
            bottom: `calc(${fabBottom}px + env(safe-area-inset-bottom, 0px))`,
            touchAction: "none",
          }}
          onTouchStart={handleFabTouchStart}
          onPointerDown={handleFabPointerDown}
          aria-label="打开 AI 助手"
        >
          <Sparkles className="h-5 w-5 text-white" />
        </button>
      )}

      {/* ── 选区动作菜单（选中文字后出现） ── */}
      {selectionMenu && (
        <SelectionActionMenu
          anchorX={selectionMenu.anchorX}
          anchorY={selectionMenu.anchorY}
          primaryActions={primarySelectionActions}
          loadingActionId={pendingSelectionActionId}
          onAction={(actionId) => {
            const action = selectionMenu ? SELECTION_ACTIONS[actionId as SelectionActionId] : null
            if (!action || !selectionMenu || pendingSelectionActionId === action.id) return
            void handleSelectionAction(action.id, selectionMenu)
          }}
        />
      )}
    </div>
  )
}

// ─── TweetCard 组件 ────────────────────────────────────────────────────────────
function TweetCard({
  tweet, index, isSelected, onTextSelect, onAiClick, isMobile,
}: {
  tweet: Tweet; index: number; isSelected: boolean
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
      const range = sel!.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const rects = range.getClientRects()
      let anchorY = rect.bottom
      if (rects.length > 0) {
        let maxBottom = rects[0].bottom
        for (let i = 1; i < rects.length; i++) {
          if (rects[i].bottom > maxBottom) maxBottom = rects[i].bottom
        }
        anchorY = maxBottom
      }
      onTextSelect(text, rect.left + rect.width / 2, anchorY)
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
      }`}
      style={{ animationDelay: `${Math.min(index * 30, 300)}ms` }}
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
              className="ml-auto inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-emerald-600 hover:bg-emerald-50 active:scale-95 touch-manipulation transition-transform"
              onClick={(e) => { e.stopPropagation(); onAiClick() }}
              aria-label="推文分析"
              title="推文分析"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">推文分析</span>
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

