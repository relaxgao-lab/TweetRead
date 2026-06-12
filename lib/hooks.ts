import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * 文本选中期间，鼠标拖到滚动容器边缘时自动滚动，方便跨屏扩大选区。
 * 仅对桌面端鼠标操作有效，不影响手机端 touch 选文。
 */
export function useSelectionScrollLock(scrollRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    let isSelecting = false
    let startY = 0
    let pointerY = 0
    let rafId: number | null = null
    const edgeActivationPx = 36
    const minDragBeforeScrollPx = 72

    const stopAutoScroll = () => {
      if (rafId != null) cancelAnimationFrame(rafId)
      rafId = null
    }

    const tickAutoScroll = () => {
      if (!isSelecting) {
        stopAutoScroll()
        return
      }

      const rect = container.getBoundingClientRect()
      if (Math.abs(pointerY - startY) < minDragBeforeScrollPx) {
        stopAutoScroll()
        return
      }

      const edgeSize = Math.min(edgeActivationPx, Math.max(24, rect.height * 0.08))
      const topDistance = pointerY - rect.top
      const bottomDistance = rect.bottom - pointerY
      let delta = 0

      if (topDistance < edgeSize) {
        const intensity = Math.min(1, Math.max(0, (edgeSize - topDistance) / edgeSize))
        delta = -Math.ceil(4 + intensity * 18)
      } else if (bottomDistance < edgeSize) {
        const intensity = Math.min(1, Math.max(0, (edgeSize - bottomDistance) / edgeSize))
        delta = Math.ceil(4 + intensity * 18)
      }

      if (delta !== 0) {
        container.scrollTop += delta
        rafId = requestAnimationFrame(tickAutoScroll)
      } else {
        stopAutoScroll()
      }
    }

    const startAutoScroll = () => {
      if (rafId == null) rafId = requestAnimationFrame(tickAutoScroll)
    }

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element
      if (target.closest('.select-text')) {
        isSelecting = true
        startY = e.clientY
        pointerY = e.clientY
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!isSelecting) return
      pointerY = e.clientY
      const rect = container.getBoundingClientRect()
      const draggedFarEnough = Math.abs(pointerY - startY) >= minDragBeforeScrollPx
      if (draggedFarEnough && (pointerY < rect.top + edgeActivationPx || pointerY > rect.bottom - edgeActivationPx)) {
        startAutoScroll()
      } else {
        stopAutoScroll()
      }
    }

    const onMouseUp = () => {
      isSelecting = false
      stopAutoScroll()
    }

    container.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)

    return () => {
      stopAutoScroll()
      container.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [scrollRef])
}

/**
 * Claude 风格的“最新轮锚定”滚动策略。
 *
 * 行为契约：
 * 1. 用户提交新消息：进入 `latestTurnMode`，在消息列表底部撑开一段“占位空白”，
 *    然后把该用户消息精确对齐到滚动容器顶端，旧内容因此被顶出屏幕。
 * 2. AI 流式输出阶段：不再主动滚动；占位空白随回答变长按需收缩。
 * 3. 用户主动下滑到“内容末尾”或点击“回到底部”：清除锚定与占位，恢复跟随。
 * 4. 用户主动上滑：清除锚定，进入“手动阅读”状态，仅显示新消息提示。
 *
 * 关键实现细节：spacer 由 hook 直接通过 ref 操作 DOM 的 `style.height`，避免
 * React 状态更新与 DOM 提交存在时间差，导致定位计算用到陈旧的 spacer 高度。
 */
export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  endRef: RefObject<HTMLElement | null>,
  messages: { role: string }[],
  options?: {
    bottomThreshold?: number
    /** 返回该索引对应的“用户消息节点”，用于把它对齐到滚动容器顶端。 */
    getUserMessageNode?: (messageIndex: number) => HTMLElement | null
  },
): {
  userScrolledUp: boolean
  latestTurnMode: boolean
  hasNewMessage: boolean
  /** 消费方需把它挂到列表末尾、`messagesEndRef` 之前的占位 div 上。 */
  spacerRef: RefObject<HTMLDivElement | null>
  scrollToBottom: () => void
} {
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const [latestTurnMode, setLatestTurnMode] = useState(false)
  const [hasNewMessage, setHasNewMessage] = useState(false)

  const spacerRef = useRef<HTMLDivElement>(null)
  const userScrolledUpRef = useRef(false)
  const latestTurnModeRef = useRef(false)
  const latestTurnUserIndexRef = useRef<number | null>(null)
  const atBottomRef = useRef(true)
  const prevLengthRef = useRef(0)
  const prevLastRoleRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)
  const bottomThreshold = options?.bottomThreshold ?? 80

  const getSpacerHeight = useCallback(() => spacerRef.current?.offsetHeight ?? 0, [])

  const setSpacerHeightDOM = useCallback((px: number) => {
    const node = spacerRef.current
    if (!node) return
    const next = Math.max(0, Math.round(px))
    const current = node.offsetHeight
    if (next === current) return
    node.style.height = `${next}px`
  }, [])

  const setScrolledUp = (value: boolean) => {
    userScrolledUpRef.current = value
    setUserScrolledUp(value)
  }

  const setLatestTurn = useCallback(
    (value: boolean, userIndex: number | null = null) => {
      latestTurnModeRef.current = value
      latestTurnUserIndexRef.current = value ? userIndex : null
      setLatestTurnMode(value)
      if (!value) setSpacerHeightDOM(0)
    },
    [setSpacerHeightDOM],
  )

  const isNearContentBottom = useCallback(
    (container: HTMLElement) => {
      const effectiveBottom = container.scrollHeight - getSpacerHeight()
      const distance = effectiveBottom - container.scrollTop - container.clientHeight
      return distance <= bottomThreshold
    },
    [bottomThreshold, getSpacerHeight],
  )

  const measureUserOffset = useCallback(() => {
    const container = containerRef.current
    const idx = latestTurnUserIndexRef.current
    if (!container || idx == null) return null
    const node = options?.getUserMessageNode?.(idx)
    if (!node) return null
    const cRect = container.getBoundingClientRect()
    const nRect = node.getBoundingClientRect()
    const userTopInContent = nRect.top - cRect.top + container.scrollTop
    const currentSpacer = getSpacerHeight()
    const contentEnd = container.scrollHeight - currentSpacer
    const contentAfterUser = Math.max(0, contentEnd - userTopInContent)
    return {
      userTopInContent,
      contentAfterUser,
      clientHeight: container.clientHeight,
      container,
      node,
    }
  }, [containerRef, options, getSpacerHeight])

  const recomputeSpacer = useCallback(() => {
    const m = measureUserOffset()
    if (!m) return
    setSpacerHeightDOM(Math.max(0, m.clientHeight - m.contentAfterUser))
  }, [measureUserOffset, setSpacerHeightDOM])

  const alignUserMessageToTop = useCallback(() => {
    const m = measureUserOffset()
    if (!m) return false
    const cRect = m.container.getBoundingClientRect()
    const nRect = m.node.getBoundingClientRect()
    const delta = nRect.top - cRect.top
    if (Math.abs(delta) < 0.5) return true
    m.container.scrollTop += delta
    return true
  }, [measureUserOffset])

  const scheduleScrollToBottom = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      const node = containerRef.current
      if (!node) return
      node.scrollTop = node.scrollHeight
      atBottomRef.current = true
      setHasNewMessage(false)
      rafRef.current = null
    })
  }, [containerRef])

  // ResizeObserver：容器尺寸变化（拖拽面板、手机键盘等）时重算占位
  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (latestTurnModeRef.current) recomputeSpacer()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [containerRef, recomputeSpacer])

  // scroll：仅同步“是否在内容末尾”
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    atBottomRef.current = isNearContentBottom(container)
    const onScroll = () => {
      atBottomRef.current = isNearContentBottom(container)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
  }, [containerRef, isNearContentBottom])

  // wheel：上滚 → 进入手动阅读；下滚到内容末尾 → 退出锚定
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        setLatestTurn(false)
        setScrolledUp(true)
      } else if (e.deltaY > 0 && isNearContentBottom(container)) {
        setLatestTurn(false)
        setScrolledUp(false)
        setHasNewMessage(false)
      }
    }
    container.addEventListener('wheel', onWheel, { passive: true })
    return () => container.removeEventListener('wheel', onWheel)
  }, [containerRef, isNearContentBottom, setLatestTurn])

  // touch：与 wheel 同语义
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let lastY = 0
    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches[0].clientY
    }
    const onTouchMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - lastY
      lastY = e.touches[0].clientY
      if (dy > 0) {
        setLatestTurn(false)
        setScrolledUp(true)
      } else if (dy < 0 && isNearContentBottom(container)) {
        setLatestTurn(false)
        setScrolledUp(false)
        setHasNewMessage(false)
      }
    }
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
    }
  }, [containerRef, isNearContentBottom, setLatestTurn])

  // 关键：messages 变化在浏览器绘制前同步处理，避免出现“先看到没锚定的状态再被拽上去”的闪烁。
  useLayoutEffect(() => {
    if (messages.length === 0) {
      if (latestTurnModeRef.current) setLatestTurn(false)
      prevLengthRef.current = 0
      prevLastRoleRef.current = null
      return
    }
    const container = containerRef.current
    if (!container) return

    const lastMsg = messages[messages.length - 1]
    const isNewMessage =
      messages.length !== prevLengthRef.current ||
      lastMsg.role !== prevLastRoleRef.current

    if (lastMsg.role === 'user') {
      if (isNewMessage) {
        const userIndex = messages.length - 1
        setLatestTurn(true, userIndex)
        setScrolledUp(false)
        setHasNewMessage(false)
        // 同步撑开足够高的占位，使 scrollHeight 立刻够大
        setSpacerHeightDOM(container.clientHeight)
        // 立即同步对齐（在浏览器绘制前完成，无任何中间帧的“没锚定”状态）
        alignUserMessageToTop()
        // 后续两帧兜底校准：抵消 loading dots、流式首帧、字体加载等导致的布局抖动
        requestAnimationFrame(() => {
          alignUserMessageToTop()
          recomputeSpacer()
          requestAnimationFrame(() => {
            alignUserMessageToTop()
            recomputeSpacer()
          })
        })
      }
      prevLengthRef.current = messages.length
      prevLastRoleRef.current = lastMsg.role
      return
    }

    if (latestTurnModeRef.current) {
      // AI 流式更新：只按内容长度收缩占位，不触碰 scrollTop
      recomputeSpacer()
      setHasNewMessage(true)
      prevLengthRef.current = messages.length
      prevLastRoleRef.current = lastMsg.role
      return
    }

    if (userScrolledUpRef.current || !atBottomRef.current) {
      setHasNewMessage(true)
      prevLengthRef.current = messages.length
      prevLastRoleRef.current = lastMsg.role
      return
    }

    scheduleScrollToBottom()
    prevLengthRef.current = messages.length
    prevLastRoleRef.current = lastMsg.role
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, containerRef])

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  return {
    userScrolledUp,
    latestTurnMode,
    hasNewMessage,
    spacerRef,
    scrollToBottom: () => {
      setScrolledUp(false)
      setLatestTurn(false)
      setHasNewMessage(false)
      requestAnimationFrame(() => {
        const node = containerRef.current
        if (!node) return
        node.scrollTop = node.scrollHeight
        if (endRef.current) {
          endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
        }
      })
    },
  }
}
