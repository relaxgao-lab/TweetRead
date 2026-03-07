"use client"

import type React from "react"
import Image from "next/image"
import { ChevronDown, ExternalLink, Mic, Send, Sparkles, StopCircle, Volume2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { SpeechStatus } from "@/app/conversation/whisper-speech-service"
import { formatRelativeTime, type Tweet } from "@/lib/twitter"

export interface AiMessage {
  role: "user" | "assistant"
  content: string
  quoted?: { text: string }
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
  renderAssistantContent: (content: string) => string
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

function LoadingDots() {
  return (
    <span className="inline-flex gap-0.5 text-gray-400">
      <span className="animate-dot-flash-1">·</span>
      <span className="animate-dot-flash-2">·</span>
      <span className="animate-dot-flash-3">·</span>
    </span>
  )
}

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
              {formatTweetText(selectedTweet.text)}
            </p>
            {selectedTweet.url && (
              <a
                href={selectedTweet.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-blue-400 hover:text-blue-600 mt-1"
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
          <div className="w-6 h-6 rounded-full bg-gray-200 shrink-0 flex items-center justify-center text-xs text-gray-500">
            {selectedTweet.author.name?.[0]}
          </div>
        )}
        <span className="text-xs font-semibold text-gray-800 truncate">{selectedTweet.author.name}</span>
        <span className="text-xs text-gray-400 truncate">@{selectedTweet.author.userName}</span>
      </div>
      <p className="text-xs text-gray-700 leading-relaxed">{formatTweetText(selectedTweet.text)}</p>
    </div>
  )
}

function MessageList({
  variant,
  selectedTweet,
  messages,
  isChatLoading,
  speechStatus,
  formatTweetText,
  renderAssistantContent,
  messagesEndRef,
  onAssistantTextSelect,
}: {
  variant: "desktop" | "mobile"
  selectedTweet: Tweet | null
  messages: AiMessage[]
  isChatLoading: boolean
  speechStatus: SpeechStatus
  formatTweetText: (text: string) => string
  renderAssistantContent: (content: string) => string
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  onAssistantTextSelect: (selection: AssistantSelectionPayload) => void
}) {
  const readAssistantSelection = (
    container: HTMLDivElement | null,
    messageIndex: number,
    fullMessageContent: string,
  ) => {
    if (!container) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return

    const text = sel.toString().trim()
    if (!text || text.length > 300) return

    const range = sel.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) return

    try {
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
      onAssistantTextSelect({
        text,
        anchorX: rect.left + rect.width / 2,
        anchorY,
        messageIndex,
        fullMessageContent,
      })
    } catch {}
  }

  return (
    <div
      className="flex-1 overflow-y-auto p-4 space-y-4 hide-vertical-scrollbar"
      style={variant === "mobile" ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
    >
      {!selectedTweet && (
        <div className={`flex flex-col items-center justify-center h-full text-center gap-3 ${variant === "desktop" ? "py-12" : "py-8"}`}>
          <Sparkles className={`${variant === "desktop" ? "h-10 w-10" : "h-8 w-8"} text-gray-200`} />
          <p className="text-sm font-medium text-gray-400">
            {variant === "desktop" ? "点击左侧推文" : "点击上方推文"}
          </p>
          <p className="text-xs text-gray-300">AI 将为你解读该推文</p>
        </div>
      )}

      {selectedTweet && <TweetPreview selectedTweet={selectedTweet} variant={variant} formatTweetText={formatTweetText} />}

      {selectedTweet && messages.length === 0 && (
        <div className={`text-center text-sm text-gray-500 space-y-2 ${variant === "desktop" ? "mt-8" : "mt-6"}`}>
          <p className="font-medium">有什么问题想了解吗？</p>
          <p className="text-xs text-gray-400">
            {variant === "desktop" ? "点击下方快捷按钮，或直接输入问题" : "点击下方快捷按钮，或直接输入"}
          </p>
        </div>
      )}

      {messages.map((msg, i) => (
        <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
          {msg.role === "user" && (
            <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium bg-violet-500 text-white">
              我
            </div>
          )}
          <div className={`flex-1 min-w-0 text-sm leading-relaxed ${msg.role === "user" ? "text-right" : "text-gray-800"}`}>
            {msg.role === "user" ? (
              <div className="inline-block max-w-[85%] rounded-2xl bg-violet-50 border border-violet-100 overflow-hidden text-left">
                {msg.quoted && (
                  <div className="border-b border-violet-100 bg-violet-50/70 px-4 py-2">
                    <p className="text-xs leading-relaxed text-violet-900 line-clamp-2 whitespace-pre-wrap break-words">
                      {msg.quoted.text}
                    </p>
                  </div>
                )}
                <div className="px-4 py-2 text-gray-900">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div
                  className="rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 whitespace-pre-wrap select-text"
                  onMouseUp={(e) => readAssistantSelection(e.currentTarget, i, msg.content)}
                  onTouchEnd={(e) => {
                    if (variant !== "mobile") return
                    const container = e.currentTarget
                    requestAnimationFrame(() => readAssistantSelection(container, i, msg.content))
                  }}
                >
                  {msg.content ? renderAssistantContent(msg.content) : <LoadingDots />}
                </div>
                {i === messages.length - 1 && speechStatus === "speaking" && (
                  <div className="flex items-center gap-2 text-xs text-emerald-600 pt-1">
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

      {isChatLoading && (
        <div className="flex gap-3">
          <div className="flex-1 min-w-0">
            <div className="inline-block rounded-2xl bg-gray-50 border border-gray-100 px-4 py-2 text-sm text-gray-500">
              <LoadingDots />
            </div>
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  )
}

function PresetPromptBar({
  selectedTweet,
  isChatLoading,
  speechStatus,
  onSendPreset,
}: {
  selectedTweet: Tweet | null
  isChatLoading: boolean
  speechStatus: SpeechStatus
  onSendPreset: (text: string) => void
}) {
  if (!selectedTweet) return null

  return (
    <div className="shrink-0 px-4 py-2 border-t border-gray-100 bg-gray-50/80">
      <div className="flex flex-wrap gap-x-3 gap-y-2 pt-1">
        {PRESET_PROMPTS.map((prompt, i) => {
          const c = pastelColors[i % pastelColors.length]
          return (
            <Button
              key={prompt.label}
              type="button"
              variant="outline"
              size="sm"
              disabled={isChatLoading || speechStatus === "recording" || speechStatus === "processing"}
              onClick={() => onSendPreset(prompt.text)}
              className={`text-xs h-9 px-4 rounded-xl border ${c.bg} ${c.border} ${c.text} ${c.hover} disabled:opacity-50 transition-all`}
            >
              {prompt.label}
            </Button>
          )
        })}
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
  return (
    <div className={`shrink-0 border-t border-gray-200 ${variant === "desktop" ? "p-4" : "p-3"} bg-gray-50/80`}>
      {speechError && (
        <div className="mb-2 text-xs text-red-600 flex items-center justify-between gap-2">
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
              <p className="text-[11px] font-medium text-emerald-700">基于已选回复继续追问</p>
              <p className="mt-1 text-xs leading-relaxed text-emerald-900 line-clamp-2 whitespace-pre-wrap break-words">
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
            disabled={isChatLoading || !selectedTweet || speechStatus === "processing"}
            className="block w-full min-h-[44px] max-h-[120px] text-sm resize-none pt-2.5 px-3 border-0 focus-visible:ring-0 focus-visible:ring-offset-0 bg-transparent placeholder:text-gray-400"
            rows={1}
          />
          <div className="flex items-center justify-end gap-1.5 p-1.5 shrink-0">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onVoiceToggle}
              disabled={isChatLoading || !selectedTweet || speechStatus === "processing"}
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
              disabled={!inputText.trim() || isChatLoading || !selectedTweet}
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
    renderAssistantContent,
    sheetState,
  } = props

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className={`shrink-0 px-4 py-2 border-b border-gray-200 ${variant === "desktop" ? "bg-gray-50/80" : "bg-gray-50"} flex items-center justify-between gap-2`}>
        {variant === "desktop" ? (
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-700">AI 解读助手</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {selectedTweet ? `@${selectedTweet.author.userName}` : "点击左侧推文开始分析"}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 min-w-0">
            <Sparkles className="h-4 w-4 text-emerald-600 shrink-0" />
            <h3 className="text-sm font-semibold text-gray-700">AI 解读助手</h3>
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
        speechStatus={speechStatus}
        formatTweetText={formatTweetText}
        renderAssistantContent={renderAssistantContent}
        messagesEndRef={messagesEndRef}
        onAssistantTextSelect={onAssistantTextSelect}
      />

      <PresetPromptBar
        selectedTweet={selectedTweet}
        isChatLoading={isChatLoading}
        speechStatus={speechStatus}
        onSendPreset={onSendPreset}
      />

      <ChatInput
        variant={variant}
        selectedTweet={selectedTweet}
        inputText={inputText}
        quotedSelection={quotedSelection}
        isChatLoading={isChatLoading}
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
