import { RefObject, useEffect, useRef, useState } from 'react'

/**
 * 在文本选中期间锁定滚动容器的位置，防止拖拽扩大选区时页面跟着滚动。
 * 仅对桌面端鼠标操作有效，不影响手机端 touch 选文。
 */
export function useSelectionScrollLock(scrollRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return

    let isSelecting = false
    let frozenTop = 0

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element
      if (target.closest('.select-text')) {
        isSelecting = true
        frozenTop = container.scrollTop
      }
    }

    const onScroll = () => {
      if (isSelecting) {
        container.scrollTop = frozenTop
      }
    }

    const onMouseUp = () => {
      isSelecting = false
    }

    container.addEventListener('mousedown', onMouseDown)
    container.addEventListener('scroll', onScroll)
    document.addEventListener('mouseup', onMouseUp)

    return () => {
      container.removeEventListener('mousedown', onMouseDown)
      container.removeEventListener('scroll', onScroll)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [scrollRef])
}

/**
 * 仿 Claude.ai 的智能自动滚动。
 *
 * 核心思路：
 * 1. 用 wheel / touchmove 检测"用户意图向上滚"——而不是监听 scroll 事件。
 *    scroll 事件无法区分用户行为和程序滚动；wheel/touch 只由真实用户触发。
 * 2. 用 IntersectionObserver 监视底部哨兵元素。
 *    当哨兵重新进入视口（用户滚回底部 or 点击按钮），自动恢复跟随——
 *    不需要任何 isProgrammaticScroll 标志位。
 * 3. 流式更新用 instant（scrollTop = scrollHeight），不堆积平滑动画。
 * 4. 新一轮对话（用户发消息）强制滚底，并重置状态。
 */
export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  endRef: RefObject<HTMLElement | null>,
  messages: { role: string }[],
): { userScrolledUp: boolean; scrollToBottom: () => void } {
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const userScrolledUpRef = useRef(false)

  const setScrolledUp = (value: boolean) => {
    userScrolledUpRef.current = value
    setUserScrolledUp(value)
  }

  // 1. wheel 事件：向上滚滚轮 → 标记用户主动离开底部
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) setScrolledUp(true)
    }
    container.addEventListener('wheel', onWheel, { passive: true })
    return () => container.removeEventListener('wheel', onWheel)
  }, [containerRef])

  // 2. touch 事件：手指上滑 → 标记用户主动离开底部（移动端）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let lastY = 0
    const onTouchStart = (e: TouchEvent) => { lastY = e.touches[0].clientY }
    const onTouchMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - lastY
      lastY = e.touches[0].clientY
      if (dy > 0) setScrolledUp(true) // 手指向下移动 = 内容向上滚
    }
    container.addEventListener('touchstart', onTouchStart, { passive: true })
    container.addEventListener('touchmove', onTouchMove, { passive: true })
    return () => {
      container.removeEventListener('touchstart', onTouchStart)
      container.removeEventListener('touchmove', onTouchMove)
    }
  }, [containerRef])

  // 3. IntersectionObserver：哨兵元素重新进入视口 → 恢复自动跟随
  useEffect(() => {
    const sentinel = endRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setScrolledUp(false)
      },
      // rootMargin 给 80px 缓冲，接近底部就视为"在底部"
      { root: containerRef.current, rootMargin: '0px 0px 80px 0px', threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [containerRef, endRef])

  // 4. messages 变化时决定是否滚动
  useEffect(() => {
    if (messages.length === 0) return
    const container = containerRef.current
    if (!container) return

    const lastMsg = messages[messages.length - 1]

    if (lastMsg.role === 'user') {
      // 用户发出新消息 → 强制滚底，重置状态
      setScrolledUp(false)
      container.scrollTop = container.scrollHeight
      return
    }

    // assistant 流式更新 → 只在用户没主动离开底部时跟随
    if (userScrolledUpRef.current) return
    container.scrollTop = container.scrollHeight
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, containerRef])

  return {
    userScrolledUp,
    scrollToBottom: () => {
      setScrolledUp(false)
      endRef.current?.scrollIntoView({ behavior: 'smooth' })
    },
  }
}
