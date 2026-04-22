"use client"

import type React from "react"
import { Fragment, memo, useMemo, useRef } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkBreaks from "remark-breaks"
import { useAutoScroll } from "@/lib/hooks"
import Image from "next/image"
import { ChevronDown, ChevronUp, ExternalLink, Mic, Send, Sparkles, StopCircle, Volume2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { SpeechStatus } from "@/app/conversation/whisper-speech-service"
import { formatRelativeTime, type Tweet } from "@/lib/twitter"
import { useSelectionScrollLock } from "@/lib/hooks"
import { readSelectionAnchor } from "@/lib/selection"

export interface AiMessage {
  role: "user" | "assistant"
  content: string
  quoted?: { text: string }
  displayContent?: string
}

type SheetState = "hidden" | "half" | "full"

type AssistantSelectionPayload = {
  text: string
  anchorX: number
  anchorY: number
  messageIndex: number
  fullMessageContent: string
}

type QuotedSelection = {
  text: string
}

type AiPanelProps = {
  variant: "desktop" | "mobile"
  selectedTweet: Tweet | null
  messages: AiMessage[]
  inputText: string
  quotedSelection: QuotedSelection | null
  isChatLoading: boolean
  speechStatus: SpeechStatus
  speechError: string | null
  onClose: () => void
  onSendPreset: (text: string) => void
  onInputChange: (value: string) => void
  onAssistantTextSelect: (selection: AssistantSelectionPayload) => void
  onClearQuotedSelection: () => void
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onVoiceToggle: () => void
  onDismissSpeechError: () => void
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  formatTweetText: (text: string) => string
  width?: number
  minWidth?: number
  isOpen?: boolean
  noTransition?: boolean
  sheetHeight?: number
  isDragging?: boolean
  sheetState?: SheetState
  onHandleTouchStart?: React.TouchEventHandler<HTMLDivElement>
  onHandleTouchMove?: React.TouchEventHandler<HTMLDivElement>
  onHandleTouchEnd?: React.TouchEventHandler<HTMLDivElement>
  onExpand?: () => void
  /** 评论归纳：由父组件拉全评论后发起对话；未传入则不显示按钮 */
  onCommentAnalysis?: () => void
  /** 正在拉取评论（含评论分析触发的分页） */
  commentsLoading?: boolean
  /** 评论分析：已展示用户气泡，正在拉取/整理评论数据 */
  commentAnalysisPrefetching?: boolean
}

const PRESET_PROMPTS = [
  { label: "翻译", text: "请将这条推文翻译成中文，并保持原意。" },
  { label: "解释背景", text: "请解释这条推文的背景，帮我理解它的含义和重要性。" },
  { label: "总结要点", text: "请用简洁的中文总结这条推文的核心要点。" },
  { label: "市场影响", text: "请分析这条信息对市场或相关领域可能的影响。" },
]

const pastelColors = [
  { bg: "bg-slate-100", border: "border-slate-200", text: "text-slate-700", hover: "hover:bg-slate-200/60" },
  { bg: "bg-violet-100", border: "border-violet-200", text: "text-violet-700", hover: "hover:bg-violet-200/60" },
  { bg: "bg-pink-100", border: "border-pink-200", text: "text-pink-700", hover: "hover:bg-pink-200/60" },
  { bg: "bg-amber-100", border: "border-amber-200", text: "text-amber-800", hover: "hover:bg-amber-200/60" },
]

const voiceColor = {
  bg: "bg-emerald-100",
  border: "border-emerald-200",
  text: "text-emerald-700",
  hover: "hover:bg-emerald-200/60",
}

const commentAnalysisColor = {
  bg: "bg-sky-100",
  border: "border-sky-200",
  text: "text-sky-800",
  hover: "hover:bg-sky-200/60",
}

function LoadingDots() {
  return (
    <span className="inline-flex gap-0.5 text-gray-400">
      <span className="animate-dot-flash-1">·</span>
      <span className="animate-dot-flash-2">·</span>
      <span className="animate-dot-flash-3">·</span>
    </span>
  )
}

const CHIP_OPEN = "\u200B\u200B"
const CHIP_SEP_ROLE = "\u200C"
const CHIP_SEP_BETWEEN = "\u200D"
const CHIP_SEP_TEXT = "\u200E"
const CHIP_CLOSE = "\u200B\u200B"
const CHIP_PATTERN = /\u200B\u200B([^\u200B-\u200E]*)\u200C([^\u200B-\u200E]*)\u200D([^\u200B-\u200E]*)\u200E([^\u200B-\u200E]*)\u200B\u200B/g
const RAW_CHIP_PATTERN = /\[([^\]\n]{1,160})\]\{([A-Za-z\u4e00-\u9fa5][^\}\n]{0,80})\}/g

const ROLE_STYLES: Record<string, string> = {
  subject: "bg-sky-100 text-sky-800 border-sky-200",
  主语: "bg-sky-100 text-sky-800 border-sky-200",
  predicate: "bg-emerald-100 text-emerald-800 border-emerald-200",
  谓语: "bg-emerald-100 text-emerald-800 border-emerald-200",
  verb: "bg-emerald-100 text-emerald-800 border-emerald-200",
  动词: "bg-emerald-100 text-emerald-800 border-emerald-200",
  object: "bg-amber-100 text-amber-800 border-amber-200",
  宾语: "bg-amber-100 text-amber-800 border-amber-200",
  "direct object": "bg-amber-100 text-amber-800 border-amber-200",
  直接宾语: "bg-amber-100 text-amber-800 border-amber-200",
  "indirect object": "bg-orange-100 text-orange-800 border-orange-200",
  间接宾语: "bg-orange-100 text-orange-800 border-orange-200",
  complement: "bg-orange-100 text-orange-800 border-orange-200",
  补语: "bg-orange-100 text-orange-800 border-orange-200",
  adverbial: "bg-violet-100 text-violet-800 border-violet-200",
  状语: "bg-violet-100 text-violet-800 border-violet-200",
  "adverbial clause": "bg-violet-100 text-violet-800 border-violet-200",
  状语从句: "bg-violet-100 text-violet-800 border-violet-200",
  "adverbial clause of reason": "bg-violet-100 text-violet-800 border-violet-200",
  原因状语从句: "bg-violet-100 text-violet-800 border-violet-200",
  "adverbial clause of time": "bg-violet-100 text-violet-800 border-violet-200",
  时间状语从句: "bg-violet-100 text-violet-800 border-violet-200",
  "adverbial clause of condition": "bg-violet-100 text-violet-800 border-violet-200",
  条件状语从句: "bg-violet-100 text-violet-800 border-violet-200",
  "adverbial clause of purpose": "bg-violet-100 text-violet-800 border-violet-200",
  目的状语从句: "bg-violet-100 text-violet-800 border-violet-200",
  "adverbial clause of result": "bg-violet-100 text-violet-800 border-violet-200",
  结果状语从句: "bg-violet-100 text-violet-800 border-violet-200",
  "adverbial clause of concession": "bg-violet-100 text-violet-800 border-violet-200",
  让步状语从句: "bg-violet-100 text-violet-800 border-violet-200",
  adjunct: "bg-violet-100 text-violet-800 border-violet-200",
  attributive: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  定语: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  "attributive clause": "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  定语从句: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200",
  clause: "bg-purple-100 text-purple-800 border-purple-200",
  从句: "bg-purple-100 text-purple-800 border-purple-200",
  "noun clause": "bg-purple-100 text-purple-800 border-purple-200",
  名词性从句: "bg-purple-100 text-purple-800 border-purple-200",
  conjunction: "bg-gray-100 text-gray-700 border-gray-200",
  连词: "bg-gray-100 text-gray-700 border-gray-200",
  preposition: "bg-slate-100 text-slate-700 border-slate-200",
  介词: "bg-slate-100 text-slate-700 border-slate-200",
  "prepositional phrase": "bg-slate-100 text-slate-700 border-slate-200",
  介词短语: "bg-slate-100 text-slate-700 border-slate-200",
  modifier: "bg-teal-100 text-teal-800 border-teal-200",
  修饰语: "bg-teal-100 text-teal-800 border-teal-200",
  appositive: "bg-cyan-100 text-cyan-800 border-cyan-200",
  同位语: "bg-cyan-100 text-cyan-800 border-cyan-200",
}

function chipClass(role: string): string {
  const key = role.trim().toLowerCase()
  return ROLE_STYLES[key] ?? ROLE_STYLES[role.trim()] ?? "bg-pink-100 text-pink-800 border-pink-200"
}

function splitBilingual(raw: string): { en: string; zh: string } {
  const parts = raw.split("|")
  if (parts.length >= 2) {
    return { en: parts[0].trim(), zh: parts.slice(1).join("|").trim() }
  }
  return { en: raw.trim(), zh: "" }
}

function Chip({
  roleEn,
  roleZh,
  textEn,
  textZh,
}: {
  roleEn: string
  roleZh: string
  textEn: string
  textZh: string
}) {
  const styleKey = roleEn || roleZh
  const showTextZh = textZh && textZh !== textEn
  const showRoleZh = roleZh && roleEn.toLowerCase() !== roleZh.toLowerCase()
  return (
    <span
      className={`inline-flex items-baseline gap-1.5 px-2 py-0.5 mx-0.5 my-0.5 rounded-md border text-[0.9em] leading-tight whitespace-nowrap align-baseline ${chipClass(styleKey)}`}
      data-chip-role={styleKey}
    >
      <span className="font-medium">
        {textEn}
        {showTextZh && <span className="text-[0.85em] opacity-70 font-normal"> / {textZh}</span>}
      </span>
      <span className="text-[0.72em] opacity-70 font-normal border-l border-current/30 pl-1.5">
        {roleEn}
        {showRoleZh && <span>·{roleZh}</span>}
      </span>
    </span>
  )
}

function preprocessChips(md: string): string {
  const replaced = md.replace(RAW_CHIP_PATTERN, (_, text: string, role: string) => {
    const t = splitBilingual(text)
    const r = splitBilingual(role)
    return `${CHIP_OPEN}${r.en}${CHIP_SEP_ROLE}${r.zh}${CHIP_SEP_BETWEEN}${t.en}${CHIP_SEP_TEXT}${t.zh}${CHIP_CLOSE}`
  })

  // Defense: the AI occasionally wraps the annotation paragraph in a code block
  // or inline code, which blocks chip rendering. If a code region's content
  // contains chip sentinels, unwrap it so the chips render as real elements.
  // Fenced code block (```lang\n...\n``` or ```\n...\n```) whose body contains
  // at least one chip sentinel → strip the fences.
  const strippedFenced = replaced.replace(
    /```[^\n`]*\n([\s\S]*?)\n?```/g,
    (whole, body: string) => (body.includes(CHIP_OPEN) ? body : whole),
  )
  // Inline code `...` whose body contains chip sentinels → strip the backticks.
  const strippedInline = strippedFenced.replace(
    /`([^`\n]*)`/g,
    (whole, body: string) => (body.includes(CHIP_OPEN) ? body : whole),
  )
  return strippedInline
}

function renderStringWithChips(input: string, keyPrefix: string): React.ReactNode {
  if (!input.includes(CHIP_OPEN)) return input
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  const re = new RegExp(CHIP_PATTERN.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    if (m.index > lastIndex) parts.push(input.slice(lastIndex, m.index))
    const [, roleEn, roleZh, textEn, textZh] = m
    parts.push(
      <Chip
        key={`${keyPrefix}-${m.index}`}
        roleEn={roleEn}
        roleZh={roleZh}
        textEn={textEn}
        textZh={textZh}
      />,
    )
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < input.length) parts.push(input.slice(lastIndex))
  return parts
}

function withChips(children: React.ReactNode, keyPrefix = "c"): React.ReactNode {
  if (children == null || typeof children === "boolean") return children
  if (typeof children === "string") return renderStringWithChips(children, keyPrefix)
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      const rendered = withChips(child, `${keyPrefix}-${i}`)
      if (Array.isArray(rendered)) {
        return <Fragment key={`${keyPrefix}-${i}`}>{rendered}</Fragment>
      }
      return rendered
    })
  }
  return children
}

const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{withChips(children)}</p>
  ),
  h1: ({ children }) => (
    <h1 className="text-[1.05em] font-semibold text-gray-900 mt-3 mb-1.5 first:mt-0">
      {withChips(children)}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[1em] font-semibold text-gray-900 mt-3 mb-1.5 first:mt-0">
      {withChips(children)}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[0.95em] font-semibold text-gray-900 mt-2 mb-1 first:mt-0">
      {withChips(children)}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-[0.9em] font-semibold text-gray-900 mt-2 mb-1 first:mt-0">
      {withChips(children)}
    </h4>
  ),
  ul: ({ children }) => (
    <ul className="my-1.5 pl-5 space-y-1 list-disc marker:text-gray-400">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 pl-5 space-y-1 list-decimal marker:text-gray-400">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{withChips(children)}</li>,
  strong: ({ children }) => (
    <strong className="font-semibold text-gray-900">{withChips(children)}</strong>
  ),
  em: ({ children }) => <em className="italic text-gray-700">{withChips(children)}</em>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-emerald-600 hover:text-emerald-700 hover:underline"
    >
      {withChips(children)}
    </a>
  ),
  code: ({ className, children }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-")
    if (isBlock) {
      return <code className={className}>{children}</code>
    }
    return (
      <code className="px-1 py-0.5 rounded bg-gray-200/70 text-[0.9em] font-mono text-gray-800">
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="my-2 p-2.5 rounded-lg bg-gray-900 text-gray-100 text-sm overflow-x-auto">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 pl-3 pr-2 py-2 border-l-4 border-emerald-400 bg-emerald-50/60 rounded-r-md text-gray-700 not-italic font-mono text-[0.9em]">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-t border-gray-200" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full text-sm border border-gray-200 rounded-md overflow-hidden">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gray-100">{children}</thead>,
  th: ({ children }) => (
    <th className="px-2 py-1.5 text-left font-semibold text-gray-800 border-b border-gray-200">
      {withChips(children)}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1.5 text-gray-700 border-b border-gray-100 align-top">
      {withChips(children)}
    </td>
  ),
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

export const AssistantMarkdown = memo(function AssistantMarkdown({ text }: { text: string }) {
  const processed = useMemo(() => preprocessChips(text), [text])
  return (
    <div className="assistant-markdown text-base leading-relaxed text-gray-800 break-words">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {processed}
      </ReactMarkdown>
    </div>
  )
})

function TweetPreview({
  selectedTweet,
  variant,
  formatTweetText,
}: {
  selectedTweet: Tweet
  variant: "desktop" | "mobile"
  formatTweetText: (text: string) => string
}) {
  if (variant === "desktop") {
    return (
      <div className="shrink-0 border-b border-gray-200/80 bg-gray-50/50 px-4 py-3">
        <div className="flex items-start gap-2.5">
          {selectedTweet.author.profilePicture ? (
            <Image
              src={selectedTweet.author.profilePicture}
              alt={selectedTweet.author.name}
              width={32}
              height={32}
              className="w-8 h-8 rounded-full object-cover shrink-0"
              unoptimized
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-bold shrink-0">
              {selectedTweet.author.name?.[0] ?? "?"}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-1 flex-wrap">
              <span className="text-sm font-semibold text-gray-900">{selectedTweet.author.name}</span>
              <span className="text-sm text-gray-400">@{selectedTweet.author.userName}</span>
              <span className="text-sm text-gray-300">·</span>
              <span className="text-sm text-gray-400">{formatRelativeTime(selectedTweet.createdAt)}</span>
            </div>
            <p className="mt-1 text-sm text-gray-700 leading-relaxed whitespace-pre-wrap break-words line-clamp-5">
              {formatTweetText(selectedTweet.text)}
            </p>
            {selectedTweet.url && (
              <a
                href={selectedTweet.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-600 mt-1"
              >
                <ExternalLink className="h-2.5 w-2.5" />
                查看原文
              </a>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 mb-1">
      <div className="flex items-center gap-2 mb-1.5">
        {selectedTweet.author.profilePicture ? (
          <img
            src={selectedTweet.author.profilePicture}
            alt={selectedTweet.author.name}
            className="w-6 h-6 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="w-6 h-6 rounded-full bg-gray-200 shrink-0 flex items-center justify-center text-sm text-gray-500">
            {selectedTweet.author.name?.[0]}
          </div>
        )}
        <span className="text-sm font-semibold text-gray-800 truncate">{selectedTweet.author.name}</span>
        <span className="text-sm text-gray-400 truncate">@{selectedTweet.author.userName}</span>
      </div>
      <p className="text-sm text-gray-700 leading-relaxed">{formatTweetText(selectedTweet.text)}</p>
    </div>
  )
}

function MessageList({
  variant,
  selectedTweet,
  messages,
  isChatLoading,
  commentAnalysisPrefetching,
  speechStatus,
  formatTweetText,
  messagesEndRef,
  onAssistantTextSelect,
}: {
  variant: "desktop" | "mobile"
  selectedTweet: Tweet | null
  messages: AiMessage[]
  isChatLoading: boolean
  commentAnalysisPrefetching?: boolean
  speechStatus: SpeechStatus
  formatTweetText: (text: string) => string
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  onAssistantTextSelect: (selection: AssistantSelectionPayload) => void
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  useSelectionScrollLock(scrollContainerRef)
  const { userScrolledUp, scrollToBottom } = useAutoScroll(scrollContainerRef, messagesEndRef, messages)
  const showScrollButton = userScrolledUp && isChatLoading

  const readAssistantSelection = (
    container: HTMLDivElement | null,
    messageIndex: number,
    fullMessageContent: string,
  ) => {
    if (!container) return
    const anchor = readSelectionAnchor({ container, maxLength: 300 })
    if (!anchor) return
    onAssistantTextSelect({
      text: anchor.text,
      anchorX: anchor.anchorX,
      anchorY: anchor.anchorY,
      messageIndex,
      fullMessageContent,
    })
  }

  return (
    <div className="relative flex-1 min-h-0">
      {showScrollButton && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-gray-200 shadow-md text-sm text-gray-600 hover:bg-gray-50 transition-colors"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          新消息
        </button>
      )}
    <div
      ref={scrollContainerRef}
      className="h-full overflow-y-auto p-4 space-y-4 hide-vertical-scrollbar"
      style={variant === "mobile" ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
    >
      {!selectedTweet && (
        <div className={`flex flex-col items-center justify-center h-full text-center gap-3 ${variant === "desktop" ? "py-12" : "py-8"}`}>
          <Sparkles className={`${variant === "desktop" ? "h-10 w-10" : "h-8 w-8"} text-gray-200`} />
          <p className="text-sm font-medium text-gray-400">
            {variant === "desktop" ? "点击左侧推文" : "点击上方推文"}
          </p>
          <p className="text-sm text-gray-300">AI 将为你解读该推文</p>
        </div>
      )}

      {selectedTweet && <TweetPreview selectedTweet={selectedTweet} variant={variant} formatTweetText={formatTweetText} />}

      {selectedTweet && messages.length === 0 && (
        <div className={`text-center text-sm text-gray-500 space-y-2 ${variant === "desktop" ? "mt-8" : "mt-6"}`}>
          <p className="font-medium">有什么问题想了解吗？</p>
          <p className="text-sm text-gray-400">
            {variant === "desktop" ? "点击下方快捷按钮，或直接输入问题" : "点击下方快捷按钮，或直接输入"}
          </p>
        </div>
      )}

      {messages.map((msg, i) => (
        <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
          {msg.role === "user" && (
            <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium bg-violet-500 text-white">
              我
            </div>
          )}
          <div className={`flex-1 min-w-0 text-base leading-relaxed ${msg.role === "user" ? "text-right" : "text-gray-800"}`}>
            {msg.role === "user" ? (
              <div className="inline-block max-w-[85%] rounded-2xl bg-violet-50 border border-violet-100 overflow-hidden text-left">
                {msg.quoted && (
                  <div className="border-b border-violet-100 bg-violet-50/70 px-4 py-2">
                    <p className="text-sm leading-relaxed text-violet-900 line-clamp-2 whitespace-pre-wrap break-words">
                      {msg.quoted.text}
                    </p>
                  </div>
                )}
                <div className="px-4 py-2 text-gray-900">
                  {msg.displayContent ?? msg.content}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div
                  className="rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 select-text"
                  onMouseUp={(e) => readAssistantSelection(e.currentTarget, i, msg.content)}
                  onTouchEnd={(e) => {
                    if (variant !== "mobile") return
                    const container = e.currentTarget
                    requestAnimationFrame(() => readAssistantSelection(container, i, msg.content))
                  }}
                >
                  {msg.content
                    ? <AssistantMarkdown text={msg.content} />
                    : <LoadingDots />}
                </div>
                {i === messages.length - 1 && speechStatus === "speaking" && (
                  <div className="flex items-center gap-2 text-sm text-emerald-600 pt-1">
                    <span className="flex items-end gap-0.5 h-4">
                      {[1, 2, 3, 4].map((n) => (
                        <span
                          key={n}
                          className={`w-1 bg-emerald-500 rounded-full origin-bottom animate-sound-wave animate-sound-wave-${n} ${n % 2 === 0 ? "h-4" : "h-3"} inline-block`}
                        />
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

      {commentAnalysisPrefetching && !isChatLoading && (
        <div className="flex gap-3" aria-busy="true" aria-live="polite">
          <div className="flex-1 min-w-0">
            <div className="inline-flex items-center gap-2.5 rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 text-base text-gray-600">
              <span
                className="h-2 w-2 shrink-0 rounded-full bg-emerald-500/90 animate-pulse motion-reduce:animate-none"
                aria-hidden
              />
              <span>正在进行数据分析</span>
              <LoadingDots />
            </div>
          </div>
        </div>
      )}

      {isChatLoading && (
        <div className="flex gap-3">
          <div className="flex-1 min-w-0">
            <div className="inline-block rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 text-base text-gray-500">
              <LoadingDots />
            </div>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
    </div>
  )
}

function PresetPromptBar({
  selectedTweet,
  isChatLoading,
  speechStatus,
  commentsLoading,
  onSendPreset,
  onCommentAnalysis,
  commentAnalysisPrefetching,
}: {
  selectedTweet: Tweet | null
  isChatLoading: boolean
  speechStatus: SpeechStatus
  commentsLoading?: boolean
  commentAnalysisPrefetching?: boolean
  onSendPreset: (text: string) => void
  onCommentAnalysis?: () => void
}) {
  if (!selectedTweet) return null

  const presetDisabled =
    isChatLoading ||
    speechStatus === "recording" ||
    speechStatus === "processing" ||
    Boolean(commentsLoading) ||
    Boolean(commentAnalysisPrefetching)
  const ac = commentAnalysisColor

  return (
    <div className="shrink-0 border-t border-gray-100 bg-gray-50/80 py-2">
      <div
        className="overflow-x-auto overscroll-x-contain px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden touch-pan-x"
        role="toolbar"
        aria-label="快捷提问"
      >
        <div className="flex w-max min-w-full flex-nowrap items-center gap-3 pt-1 pb-0.5">
          {PRESET_PROMPTS.map((prompt, i) => {
            const c = pastelColors[i % pastelColors.length]
            return (
              <Button
                key={prompt.label}
                type="button"
                variant="outline"
                size="sm"
                disabled={presetDisabled}
                onClick={() => onSendPreset(prompt.text)}
                className={`shrink-0 text-sm h-9 px-4 rounded-xl border ${c.bg} ${c.border} ${c.text} ${c.hover} disabled:opacity-50 transition-all`}
              >
                {prompt.label}
              </Button>
            )
          })}
          {onCommentAnalysis && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={presetDisabled}
              onClick={() => onCommentAnalysis()}
              className={`shrink-0 text-sm h-9 px-4 rounded-xl border ${ac.bg} ${ac.border} ${ac.text} ${ac.hover} disabled:opacity-50 transition-all`}
            >
              评论分析
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function ChatInput({
  variant,
  selectedTweet,
  inputText,
  quotedSelection,
  isChatLoading,
  commentAnalysisPrefetching,
  speechStatus,
  speechError,
  onDismissSpeechError,
  onClearQuotedSelection,
  onSubmit,
  onInputChange,
  onKeyDown,
  onVoiceToggle,
  textareaRef,
}: {
  variant: "desktop" | "mobile"
  selectedTweet: Tweet | null
  inputText: string
  quotedSelection: QuotedSelection | null
  isChatLoading: boolean
  commentAnalysisPrefetching?: boolean
  speechStatus: SpeechStatus
  speechError: string | null
  onDismissSpeechError: () => void
  onClearQuotedSelection: () => void
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
  onInputChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onVoiceToggle: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const inputBusy = isChatLoading || Boolean(commentAnalysisPrefetching)
  return (
    <div className={`shrink-0 border-t border-gray-200 ${variant === "desktop" ? "p-4" : "p-3"} bg-gray-50/80`}>
      {speechError && (
        <div className="mb-2 text-sm text-red-600 flex items-center justify-between gap-2">
          <span>{speechError}</span>
          <Button variant="ghost" size="sm" className="h-6 px-1 text-red-600" onClick={onDismissSpeechError}>
            关闭
          </Button>
        </div>
      )}
      {quotedSelection && (
        <div className="mb-2 rounded-lg border border-emerald-200 bg-emerald-50/80 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-emerald-700">基于已选回复继续追问</p>
              <p className="mt-1 text-sm leading-relaxed text-emerald-900 line-clamp-2 whitespace-pre-wrap break-words">
                {quotedSelection.text}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6 shrink-0 rounded-md text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
              onClick={onClearQuotedSelection}
              title="移除引用"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
      <form onSubmit={onSubmit}>
        <div className="flex flex-col rounded-lg border border-gray-300 bg-white shadow-sm focus-within:border-emerald-400 focus-within:ring-1 focus-within:ring-emerald-400/20 transition-all">
          <Textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={selectedTweet
              ? (variant === "desktop" ? "输入或语音...（Shift+Enter 换行）" : "输入或语音...")
              : (variant === "desktop" ? "请先点击左侧推文..." : "请先点击推文...")}
            disabled={inputBusy || !selectedTweet || speechStatus === "processing"}
            className="block w-full min-h-[44px] max-h-[120px] text-base resize-none pt-2.5 px-3 border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent placeholder:text-gray-400"
            rows={1}
          />
          <div className="flex items-center justify-end gap-1.5 p-1.5 shrink-0">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onVoiceToggle}
              disabled={inputBusy || !selectedTweet || speechStatus === "processing"}
              className="h-8 w-8 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md disabled:opacity-50 transition-colors"
              title={speechStatus === "recording" ? "停止录音" : "语音输入"}
            >
              {speechStatus === "recording"
                ? <StopCircle className="h-4 w-4 text-red-500" />
                : <Mic className="h-4 w-4" />}
            </Button>
            <Button
              type="submit"
              size="icon"
              disabled={!inputText.trim() || inputBusy || !selectedTweet}
              className="h-8 w-8 bg-emerald-600 hover:bg-emerald-700 rounded-md disabled:opacity-50 transition-colors shadow-sm"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

function PanelBody(props: AiPanelProps) {
  const {
    variant,
    selectedTweet,
    messages,
    inputText,
    quotedSelection,
    isChatLoading,
    speechStatus,
    speechError,
    onClose,
    onSendPreset,
    onInputChange,
    onAssistantTextSelect,
    onClearQuotedSelection,
    onSubmit,
    onKeyDown,
    onVoiceToggle,
    onDismissSpeechError,
    messagesEndRef,
    textareaRef,
    formatTweetText,
    sheetState,
    onExpand,
    onCommentAnalysis,
    commentsLoading,
    commentAnalysisPrefetching,
  } = props

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden relative">
      <div className={`shrink-0 px-4 py-2 border-b border-gray-200 ${variant === "desktop" ? "bg-gray-50/80" : "bg-gray-50"} flex items-center justify-between gap-2`}>
        {variant === "desktop" ? (
          <div className="min-w-0 flex items-center gap-2 truncate">
            <span className="text-base font-semibold text-gray-700 shrink-0">AI 解读助手</span>
            <span className="text-sm text-gray-500 truncate">
              {selectedTweet ? `@${selectedTweet.author.userName}` : "点击左侧推文开始分析"}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <Sparkles className="h-4 w-4 text-emerald-600 shrink-0" />
            <h3 className="text-base font-semibold text-gray-700">AI 解读助手</h3>
          </div>
        )}

        <div className={`flex items-center ${variant === "desktop" ? "gap-2" : "gap-1.5"} shrink-0`}>
          {variant === "desktop" ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-8 w-8 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-10 w-10 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md touch-manipulation"
              title={sheetState === "full" ? "缩小" : "收起"}
            >
              <ChevronDown className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>

      <MessageList
        variant={variant}
        selectedTweet={selectedTweet}
        messages={messages}
        isChatLoading={isChatLoading}
        commentAnalysisPrefetching={commentAnalysisPrefetching}
        speechStatus={speechStatus}
        formatTweetText={formatTweetText}
        messagesEndRef={messagesEndRef}
        onAssistantTextSelect={onAssistantTextSelect}
      />

      {variant === "mobile" && (sheetState === "half" || sheetState === "full") && (
        <div className="absolute right-2 bottom-[calc(10.75rem+env(safe-area-inset-bottom,0px))] z-10 flex flex-col gap-0.5 shadow-sm bg-white/95 backdrop-blur-sm rounded-lg border border-gray-100">
          {sheetState === "half" && onExpand && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onExpand}
              className="h-7 w-7 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md touch-manipulation"
              title="全屏"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-7 w-7 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-md touch-manipulation"
            title={sheetState === "full" ? "缩小" : "收起"}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <PresetPromptBar
        selectedTweet={selectedTweet}
        isChatLoading={isChatLoading}
        speechStatus={speechStatus}
        commentsLoading={commentsLoading}
        commentAnalysisPrefetching={commentAnalysisPrefetching}
        onSendPreset={onSendPreset}
        onCommentAnalysis={onCommentAnalysis}
      />

      <ChatInput
        variant={variant}
        selectedTweet={selectedTweet}
        inputText={inputText}
        quotedSelection={quotedSelection}
        isChatLoading={isChatLoading}
        commentAnalysisPrefetching={commentAnalysisPrefetching}
        speechStatus={speechStatus}
        speechError={speechError}
        onDismissSpeechError={onDismissSpeechError}
        onClearQuotedSelection={onClearQuotedSelection}
        onSubmit={onSubmit}
        onInputChange={onInputChange}
        onKeyDown={onKeyDown}
        onVoiceToggle={onVoiceToggle}
        textareaRef={textareaRef}
      />
    </div>
  )
}

export function AiPanel(props: AiPanelProps) {
  const { variant } = props

  if (variant === "desktop") {
    return (
      <div
        className={`flex flex-col shrink-0 overflow-hidden ${!props.isOpen ? "pointer-events-none" : ""}`}
        style={{
          width: props.isOpen ? props.width : 0,
          minWidth: 0,
          transition: props.noTransition ? "none" : "width 0.55s cubic-bezier(0.25, 0.1, 0.25, 1)",
        }}
      >
        <div
          className="flex flex-col flex-1 min-w-0 h-full bg-white/90 border-l border-gray-200 backdrop-blur-sm"
          style={{
            width: props.width,
            minWidth: props.minWidth,
            transform: props.isOpen ? "translateX(0)" : "translateX(100%)",
            transition: props.noTransition ? "none" : "transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)",
          }}
        >
          <PanelBody {...props} />
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-2xl overflow-hidden flex flex-col"
      style={{
        height: props.sheetHeight,
        boxShadow: "0 -4px 32px rgba(0,0,0,0.14), 0 -1px 6px rgba(0,0,0,0.06)",
        transition: props.isDragging ? "none" : "height 0.32s cubic-bezier(0.32,0.72,0,1)",
      }}
    >
      <div
        className="shrink-0 pt-2.5 pb-1 flex justify-center touch-none select-none cursor-grab active:cursor-grabbing"
        onTouchStart={props.onHandleTouchStart}
        onTouchMove={props.onHandleTouchMove}
        onTouchEnd={props.onHandleTouchEnd}
      >
        <div className="w-9 h-1 bg-gray-300 rounded-full" />
      </div>
      <PanelBody {...props} />
    </div>
  )
}
