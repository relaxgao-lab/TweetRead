"use client"

import { useState, useCallback, useRef } from "react"
import type { AiMessage } from "@/components/ai-panel"

interface SceneMeta {
  aiRole: string
  context: string
}

interface StreamOptions {
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Streams a response from /api/chat and appends it to the messages state.
 * Returns the accumulated assistant text when done.
 */
export async function streamChatResponse(
  apiMessages: { role: "user" | "assistant" | "system"; content: string }[],
  sceneMeta: SceneMeta,
  onFirstChunk: () => void,
  onDelta: (accumulated: string, isFirst: boolean) => void,
  options?: StreamOptions,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options?.signal,
    body: JSON.stringify({
      messages: apiMessages,
      sceneMeta,
      ...(options?.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
    }),
  })
  if (!res.ok) throw new Error(`Chat API ${res.status}`)
  if (!res.body) throw new Error("No response body")

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let accumulated = ""
  let firstChunk = true

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
            onFirstChunk()
          }
          onDelta(accumulated, firstChunk)
        }
      } catch {}
    }
  }
}

/**
 * Self-contained chat hook for components that manage their own message history
 * (e.g. FloatingChatWindow). Handles streaming, loading state, and abort on unmount.
 *
 * `defaultMaxTokens` 会作为该 hook 内所有请求的 max_tokens；单条消息可通过
 * `sendMessage(..., { maxTokens })` 覆盖。
 */
export function useChatStream(sceneMeta: SceneMeta, defaultMaxTokens?: number) {
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const abort = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const sendMessage = useCallback(async (
    text: string,
    displayContent?: string,
    historyOverride?: AiMessage[],
    quoted?: { text: string },
    options?: { maxTokens?: number },
  ) => {
    const trimmed = text.trim()
    if (!trimmed || isLoading) return

    setChatError(null)
    abort()
    const controller = new AbortController()
    abortRef.current = controller

    const history = historyOverride ?? messages
    const userMsg: AiMessage = { role: "user", content: trimmed, displayContent, quoted }
    const nextMessages = [...history, userMsg]
    setMessages(nextMessages)
    setIsLoading(true)

    const effectiveMaxTokens = options?.maxTokens ?? defaultMaxTokens

    try {
      await streamChatResponse(
        nextMessages.map((m) => ({ role: m.role, content: m.content })),
        sceneMeta,
        () => {
          setIsLoading(false)
          setMessages((prev) => [...prev, { role: "assistant", content: "" }])
        },
        (accumulated) => {
          setMessages((prev) => {
            const copy = [...prev]
            copy[copy.length - 1] = { role: "assistant", content: accumulated }
            return copy
          })
        },
        { signal: controller.signal, maxTokens: effectiveMaxTokens },
      )
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setIsLoading(false)
        setChatError((err as Error).message ?? "请求失败，请重试")
      }
    } finally {
      if (abortRef.current === controller) {
        setIsLoading(false)
      }
    }
  }, [isLoading, messages, sceneMeta, abort, defaultMaxTokens])

  return { messages, setMessages, isLoading, chatError, sendMessage, abort }
}
