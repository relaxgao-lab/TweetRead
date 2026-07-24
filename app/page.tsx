"use client"

import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react"
import Image from "next/image"
import { AiPanel, SynonymClickContext, type AiMessage } from "@/components/ai-panel"
import { SelectionActionMenu } from "@/components/selection-action-menu"
import { FloatingChatWindow } from "@/components/floating-chat-window"
import { streamChatResponse } from "@/lib/use-chat-stream"
import { isWordOrPhraseLookup, buildLookupPrompt } from "@/lib/prompts"
import { ACCOUNTS } from "@/config/accounts"
import type { Tweet, Article, ArticleBlock, TweetMedia } from "@/lib/twitter"
import { formatRelativeTime, formatCount, isArticleTweet } from "@/lib/twitter"
import { useSelectionScrollLock } from "@/lib/hooks"
import { readSelectionAnchor } from "@/lib/selection"
import {
  accumulateCommentsForTweet,
  buildCommentAnalysisPrompt,
} from "@/lib/comment-analysis-client"
import { Heart, Repeat2, MessageCircle, Eye, RefreshCw, ChevronDown, ChevronLeft, Sparkles, Search, X, LayoutGrid, LayoutList, BookOpen } from "lucide-react"
import { useRouter } from "next/navigation"
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
type SelectionActionId = "lookup" | "pattern" | "patternMastery" | "beginnerSentence" | "readAloud" | "explainReply" | "translateReply" | "quoteReply"
type SelectionAction = {
  id: SelectionActionId
  label: string
  buildPrompt?: (text: string, tweetText?: string) => string
  buildDraft?: () => string
  /** 该动作触发的 AI 回答所需的 max_tokens 上限（未配置则走服务端默认） */
  maxTokens?: number
}
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
type InlineAuthorRepliesState = {
  replies: Tweet[]
  loading: boolean
  loaded: boolean
  error?: string
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

function smartCase(text: string): string {
  const alpha = text.replace(/[^a-zA-Z]/g, "")
  if (!alpha.length) return text
  const upperRatio = (text.match(/[A-Z]/g)?.length ?? 0) / alpha.length
  if (upperRatio < 0.7) return text
  return text.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase())
}

function getSelectionMode(text: string): SelectionMode {
  return isWordOrPhraseLookup(text) ? 'wordOrPhrase' : 'sentenceOrPassage'
}

/** Shared spec for 句型掌握 output (used by full 句型讲解 and standalone 句型掌握 action). */
const PATTERN_MASTERY_OUTPUT_SPEC = `You are a senior English-to-Chinese language tutor for an adult Chinese-speaking learner who reads English investment, tech, and product content daily. Your job is NOT to summarize the sentence — it is to make the learner TRULY internalize the pattern so they can produce similar sentences themselves.

## 核心教学原则（务必遵守）

1. **深度优先，不是格式优先**：每个章节都要给出"为什么"，不只是"是什么"。学习者需要看到对比、辨析、误用警告。
2. **剖析整个句子的结构**：把句子拆成主句 + 从句 + 修饰成分，像庖丁解牛。不要只列零散的单词。
3. **领域语境敏感**：识别这是金融/科技/口语/社交媒体哪种语境，并解释同一个词在普通英语 vs 该领域的含义差别（例如 volume 在普通英语 = "音量"，在投资语境 = "销量/交易量"）。
4. **多用对比表格**：词义辨析、近义词区别、易混语序，全部用 markdown 表格呈现，比纯文字更清晰。
5. **个性化套用**：替换练习要结合用户已知的兴趣领域（如果上下文有线索，例如用户在聊投资/编程/育儿，就用那个领域造句）。

---

## 输出结构（严格按此顺序，使用 #### 子标题）

#### 📖 句子结构总览
先用一个 markdown 表格把整个句子拆成 2-4 个组成部分：

| 部分 | 内容 | 功能 |
|------|------|------|
| 主句/从句/修饰语 | [原文片段] | [语法功能：条件状语、主语补足语等] |

然后用一句地道的中文翻译整个句子（**不直译，翻出语气和投资/技术语境的味道**）。

#### 🔍 逐部分语法精讲
按句子的语序，依次拆解每一个有讲解价值的成分。每个成分用 ### 三级标题 + emoji 标注：

对于每一个**非显而易见**的词、短语、缩写、连词、介词，都要：

1. **指出词性和句法功能**（动词？介词？现在分词？条件连词？）
2. **解释普通含义 vs 当前语境含义**（特别是金融/科技黑话）
3. **给出 2-3 个对比例句**（用 markdown 表格，左边英文右边中文）
4. **如果是介词或连词**，对比近义词差异（用表格）
5. **如果是缩写或符号**（如 $10B+、YTD、P/E、's），明确展开并区分歧义（如 's = is/has/possessive）
6. **如果是固定搭配**（如 see sb doing sth、ramp alongside），单独拎出来作为"句型模板"讲解

> 💡 在适当位置插入 "投资圈/科技圈常用此说法" 之类的文化/领域提示

#### 🎯 可复用句型模板
不是只给一个模板，而是给 **2-3 个抽象层级不同的模板**：

**模板 1（最贴近原句）：**
> [English template with [placeholders]]
> [中文模板，占位符用【】]

**模板 2（更通用的变体）：**
> [English template]
> [中文模板]

每个模板下面给 **2 个套用示例**，示例要：
- 改变主语和领域（不是只换名字或股票代码）
- 至少有一个示例**贴近用户已知的兴趣领域**（如用户聊投资就用 $CRCL/$SIVE 等已提到的标的；用户聊编程就用 React/API 等）

#### 💡 高频搭配速查
用一个 markdown 表格汇总句子里出现的 2-4 个**地道搭配**：

| 搭配 | 中文 | 实际用法示例 |
|------|------|-------------|
| [collocation] | [meaning] | [a natural sentence] |

#### 🎨 语体与使用场景
**不是一句话**，而是要回答这 3 个问题：
- **语体**：这是 Twitter/Reddit 口语？卖方研报？正式商务？学术？
- **可以用在哪**：什么场景下学习者用这个句子是地道的？
- **不要用在哪**：什么场景下用了会显得别扭/不专业？

#### ✍️ 你来试试
用中文给学习者一个**具体、可执行的造句任务**：
- 提供一个真实场景（最好结合学习者已知的兴趣领域）
- 给出 1-2 个可以填的模板槽
- 鼓励他们在回复里写出自己的句子

示例风格：
> "现在轮到你了：你最近关注的 $XXX 也面临类似情况吗？试着用 \`If [触发因素] ramps alongside [并行因素], I see [对象] becoming [结果] [时间].\` 这个模板，写一句关于你自己持仓的预测。"

---

## 质量检查清单（生成完毕前自检）

- [ ] 句子结构总览表是否清晰拆出了 2-4 个组成部分？
- [ ] 每个非显而易见的词是否都标注了词性和当前语境含义？
- [ ] 是否至少用了 2 个 markdown 对比表格（词义辨析 / 高频搭配）？
- [ ] 模板是否给了 2-3 个抽象层级，而不是单一模板?
- [ ] 替换练习是否真正改变了主语和领域，而不是只换了名字？
- [ ] 是否至少有一个示例贴近用户已知的兴趣领域？
- [ ] 语体说明是否回答了"能用在哪 / 不能用在哪"，而不只是贴了个标签？
- [ ] "你来试试" 是否给了具体场景而不是空泛的"造句吧"？

如果任何一项没做到，重新生成对应章节。`

function buildPatternPrompt(text: string): string {
  return `Please analyze the selected sentence comprehensively based on the context: 「${text}」

1. **Sentence Meaning / 句子含义**: Explain the literal meaning of the entire sentence in both English and Chinese.
2. **Sentence Pattern Mastery / 句型掌握**: ${PATTERN_MASTERY_OUTPUT_SPEC}
3. **Key Phrase Analysis / 关键词短语解析**: Explain core phrases (idioms, slang, cultural references) in both English and Chinese.
4. **Contextual Dialogue / 语境对话**: Provide a realistic dialogue example using this sentence, with both English and Chinese versions.

**Formatting**: Use clean Markdown — headings, bullet lists, and bold emphasis are encouraged. Code blocks are only for actual code; never use them for annotations or regular sentences. Keep explanations concise.`
}

function buildPatternMasteryPrompt(text: string, tweetText?: string): string {
  const tweetBlock = tweetText ? `Source tweet (for context):\n「${tweetText}」\n\n` : ""
  return `${tweetBlock}Please analyze ONLY this selected excerpt for sentence pattern mastery: 「${text}」

IMPORTANT: Derive the pattern template directly from the selected text above. The pattern should be grounded in 「${text}」 itself. Use the source tweet above to inform your interpretation of meaning, register, and context.

${PATTERN_MASTERY_OUTPUT_SPEC}

Do not add separate sections for full-sentence paraphrase, keyword glossary, or extended dialogue.

**Formatting**: Use clean Markdown — headings, bullet lists, and bold emphasis are encouraged. Code blocks are only for actual code; never use them for annotations or regular sentences. Keep the answer concise.`
}

function buildBeginnerSentencePrompt(text: string, tweetText?: string): string {
  const tweetBlock = tweetText ? `原推文上下文（仅用于理解语气、背景和指代）：\n「${tweetText}」\n\n` : ""
  return `${tweetBlock}请讲解下面这段英文内容。你的目标不是翻译，而是帮助一个英语初学者真正理解英文表达方式，并知道哪些表达可以学、哪些只是社交媒体口语/不标准写法。

英文内容：
「${text}」

核心要求：

- 不要只翻译。
- 重点培养英语思维：多解释为什么这样说，而不是只告诉我是什么意思。
- 如果原文是 Twitter/Reddit/聊天里的碎片化英语、语法不完整或不标准，必须明确指出。
- 发现不标准写法时，不要羞辱原文；请解释这是社媒口语、快速输入、省略、断句随意，还是作者故意制造语气。
- 遇到“形式和真实功能不一致”的非常规用法，必须明确说明。例如：形式上像疑问句，但实际是在自言自语、反问、表达直觉、铺垫观点；形式上像陈述句，但实际是在讽刺、调侃或暗示。
- 必须告诉初学者：哪些表达可以放心模仿，哪些表达只能看懂、不建议正式写作模仿。
- 尽量结合美国人的真实说话习惯。
- 如果涉及财经、AI、科技、投资，请结合行业背景讲解。
- 解释要适合英语初学者阅读，避免复杂语法术语；如果必须提到语法名称，要马上用中文白话解释。

请按照下面的顺序回答：

## 1. 原文
保留英文原文。

## 2. 先判断：这句英文标准吗？

先用很短的方式判断：

- 这是标准书面英语、自然口语，还是社媒碎片化英语？
- 有没有省略、断句问题、介词缺失、搭配不自然、大小写/标点问题？
- 有没有“非常规用法”：比如疑问句不是真的提问，而是在表达直觉/怀疑/讽刺；句子断开不是完整语法，而是为了制造口语节奏。
- 初学者是否可以直接模仿？如果不能，请明确说“可以看懂，但不要照抄这种写法”。

如果原文不够标准，请给出两种改写：

1. 标准英文写法：语法更完整、适合学习者模仿。
2. 保留原推文语气的自然写法：仍然像美国网友会发的内容，但更顺。

## 3. 一句话中文翻译
用自然、符合中文表达习惯的话翻译整句话。

## 4. 一句一句拆解
把句子按照意群（而不是单词）拆开。

例如：

Why do I have this weird feeling...
→ 为什么我总有一种奇怪的感觉……

the main reason retail is excited...
→ 散户如此兴奋的主要原因……

SK Hynix NASDAQ listing
→ SK海力士在纳斯达克上市

is because...
→ 是因为……

instead of...
→ 而不是……

每一部分都解释为什么这么表达，并特别指出：

- 这里是否省略了某个词（例如 about / that / is that 等）
- 这里的句子形式和真实作用是否一致；如果不一致，要用“形式上是……，实际功能是……”解释清楚
- 这里是否是美股/科技圈常见说法
- 这里是否是可以模仿的地道表达，还是只适合看懂

特别注意这类初学者高频误解：

- "Why do I have this feeling..." / "Why do I feel like..." 形式上是疑问句，但很多时候不是认真求答案，而是“我怎么总觉得……/我有一种直觉……”。
- "Is because..." 单独开头通常不是标准完整句，而是社媒口语里把原因单独拎出来强调。
- 省略 about / that / is that / because 等连接词时，要告诉用户标准写法应该补什么。

## 5. 重点词汇

列出重要单词或短语。

格式：

- retail = retail investors，散户投资者
- degen = 赌博式投机者（网络俚语）
- call options = 看涨期权
- weird feeling = 一种说不上来的感觉

如果有俚语、金融术语、互联网黑话，也请解释来源和使用场景。

## 6. 语法分析

不要讲复杂语法名称，而是告诉我：

- 主语是什么
- 谓语是什么
- 宾语是什么
- 修饰关系是什么
- 为什么作者会这样写
- 如果我是中国人，最容易误解哪里

要求：

- 如果原句语法不完整，必须先用“标准英文改写”来分析主干。
- 分清“原句实际写法”和“标准英文里应该怎么写”。
- 不要把宾语误说成主语；如果句子里有“我觉得/我有一种感觉 that...”，要解释外层是“我有这种感觉”，内层才是真正观点。
- 尽量用中文解释，不要堆英语语法术语。

## 7. 作者真正想表达什么

很多英文不是字面意思。

请解释：

- 作者真正的观点
- 有没有讽刺、调侃、自嘲
- 情绪是什么
- 为什么美国网友会这么说

如果涉及金融、科技、投资背景，请补充背景知识。

## 8. 地道表达：哪些值得学？

把原文里值得学习的表达列出来。每个表达都要说明：

- 自然中文意思
- 使用场景
- 是否适合初学者模仿
- 更标准/更自然的表达方式

例如：

I have this weird feeling...
这是英语里非常自然的表达，
意思不是"我有一种奇怪感觉"，而是
"我总觉得……"

至少举 2-3 个类似例句。例句要短，适合初学者复用。

如果原文里有不推荐模仿的表达，也单独列出：

- 原文写法
- 为什么不建议模仿
- 推荐替代表达

## 9. 如果换成更简单的英文

把原句改写成：

- 初级英语（A2）
- 中级英语（B1）
- 标准自然英语
- 保留社媒语气的自然英语

让我知道不同水平的人会怎么表达。

## 10. 学习总结

最后总结：

① 今天最值得记住的3个表达。

② 最容易犯错的地方。

③ 我以后看到什么句型，可以马上联想到今天学到的知识。

④ 哪些原文写法“能看懂但不要模仿”。

输出质量自检：

- 是否明确判断了原文是否标准？
- 是否给出“标准英文写法”和“保留原语气的自然写法”？
- 是否指出了省略、断句或搭配不自然的地方？
- 是否告诉初学者哪些表达可以模仿，哪些不要模仿？
- 语法分析是否基于标准改写，且没有把主语/宾语说错？
- 是否结合了真实美国社媒语气和相关行业背景？
- 如果没有做到以上任何一点，请补齐后再回答。`
}

function buildAssistantDraft(actionId: SelectionActionId): string {
  switch (actionId) {
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

function TweetMediaPreview({
  media,
  onImageClick,
  compact = false,
}: {
  media: TweetMedia[]
  onImageClick?: (url: string) => void
  compact?: boolean
}) {
  const item = media.find((m) => m.url || m.previewUrl)
  if (!item) return null

  const src = item.url ?? item.previewUrl
  if (!src) return null

  const isPlayable = item.type === "video" || item.type === "animated_gif"
  return (
    <div className={`mt-2 overflow-hidden rounded-lg border border-gray-200/80 bg-gray-50 ${compact ? "max-w-sm" : ""}`}>
      <button
        type="button"
        className="relative block w-full text-left"
        onClick={(e) => {
          e.stopPropagation()
          onImageClick?.(src)
        }}
      >
        <img
          src={src}
          alt=""
          className={`${compact ? "max-h-40" : "max-h-48"} w-full object-cover`}
          loading="lazy"
        />
        {isPlayable && (
          <span className="absolute bottom-2 left-2 rounded-full bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white">
            {item.type === "animated_gif" ? "GIF" : "Video"}
          </span>
        )}
      </button>
    </div>
  )
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
  lookup: { id: "lookup", label: "查词", buildPrompt: buildLookupPrompt, maxTokens: 1500 },
  pattern: { id: "pattern", label: "句型讲解", buildPrompt: buildPatternPrompt, maxTokens: 2500 },
  patternMastery: { id: "patternMastery", label: "句型掌握", buildPrompt: buildPatternMasteryPrompt, maxTokens: 2000 },
  beginnerSentence: { id: "beginnerSentence", label: "初学者讲解", buildPrompt: buildBeginnerSentencePrompt, maxTokens: 3500 },
  explainReply: { id: "explainReply", label: "解释", buildDraft: () => buildAssistantDraft("explainReply"), maxTokens: 2000 },
  translateReply: { id: "translateReply", label: "翻译", buildDraft: () => buildAssistantDraft("translateReply"), maxTokens: 2000 },
  quoteReply: { id: "quoteReply", label: "引用", buildDraft: () => "" },
  readAloud: { id: "readAloud", label: "朗读" },
}

const PRIMARY_SELECTION_ACTIONS: SelectionActionId[] = ["lookup", "beginnerSentence", "patternMastery", "explainReply", "translateReply", "quoteReply", "readAloud"]

type SelectionPromptWindowActionId = Extract<SelectionActionId, "lookup" | "beginnerSentence" | "patternMastery">

function formatSelectionPromptWindowDisplay(actionId: SelectionPromptWindowActionId, text: string): string {
  const labels: Record<SelectionPromptWindowActionId, string> = {
    lookup: "查词",
    beginnerSentence: "初学者讲解",
    patternMastery: "句型掌握",
  }
  return `${labels[actionId]}：「${text}」`
}

function getPrimaryActions(_menu: SelectionMenuState): SelectionAction[] {
  return PRIMARY_SELECTION_ACTIONS.map((id) => SELECTION_ACTIONS[id])
}

// ─── 页面组件 ──────────────────────────────────────────────────────────────────
export default function HomePage() {
  const router = useRouter()
  // ── 显示模式 ──
  const [viewMode, setViewMode] = useState<"read" | "scan">("read")
  useEffect(() => {
    const saved = localStorage.getItem("home-view-mode")
    if (saved === "read" || saved === "scan") setViewMode(saved)
  }, [])
  const switchViewMode = (mode: "read" | "scan") => {
    setViewMode(mode)
    localStorage.setItem("home-view-mode", mode)
  }
  // ── 推文 feed ──
  const [activeTab, setActiveTab] = useState(ACCOUNTS[0].userName)
  const [cache, setCache] = useState<TweetCache>({})
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── 账户内搜索 ──
  const [searchQuery, setSearchQuery] = useState("")
  const [activeSearch, setActiveSearch] = useState("")
  const [searchCache, setSearchCache] = useState<Record<string, { tweets: Tweet[]; hasMore: boolean; nextCursor?: string }>>({})
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchLoadingMore, setSearchLoadingMore] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  const activeAccount = ACCOUNTS.find((a) => a.userName === activeTab) ?? ACCOUNTS[0]
  const current = cache[activeTab]
  const isSearchMode = activeSearch.trim().length > 0
  const searchKey = `${activeTab}::${activeSearch}`
  const currentSearch = searchCache[searchKey]
  const displayTweets = isSearchMode ? (currentSearch?.tweets ?? []) : (current?.tweets ?? [])
  const displayHasMore = isSearchMode ? (currentSearch?.hasMore ?? false) : (current?.hasMore ?? false)

  // ── AI 面板：选中推文 + 聊天 ──
  const [selectedTweet, setSelectedTweet] = useState<Tweet | null>(null)
  const [messages, setMessages] = useState<AiMessage[]>([])
  const [inputText, setInputText] = useState("")
  const [quotedSelection, setQuotedSelection] = useState<QuotedSelectionState | null>(null)
  const [isChatLoading, setIsChatLoading] = useState(false)
  const [speechStatus, setSpeechStatus] = useState<SpeechStatus>("idle")
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [isSpeechEnabled, setIsSpeechEnabled] = useState(true)

  // ── 左侧内容区域：feed | detail ──
  const [leftView, setLeftView] = useState<"feed" | "detail">("feed")
  const [detailTweet, setDetailTweet] = useState<Tweet | null>(null)

  // ── 评论视图（用于详情页内联展示）──
  const [commentsForTweet, setCommentsForTweet] = useState<Tweet | null>(null)
  const [comments, setComments] = useState<Tweet[]>([])
  const [authorReplies, setAuthorReplies] = useState<Tweet[]>([])
  const [commentsHasMore, setCommentsHasMore] = useState(false)
  const [commentsCursor, setCommentsCursor] = useState<string | undefined>(undefined)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentsError, setCommentsError] = useState<string | null>(null)
  const [commentAnalysisPrefetching, setCommentAnalysisPrefetching] = useState(false)
  const [inlineAuthorRepliesByTweet, setInlineAuthorRepliesByTweet] = useState<Record<string, InlineAuthorRepliesState>>({})
  const inlineAuthorRepliesInFlightRef = useRef<Set<string>>(new Set())

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

  // 选区菜单两阶段：actions（正常）| windowChoice（选打开位置）
  type SelectionMenuPhase = "actions" | "windowChoice"
  const [selectionMenuPhase, setSelectionMenuPhase] = useState<SelectionMenuPhase>("actions")
  const [pendingWindowChoice, setPendingWindowChoice] = useState<{
    prompt: string
    displayContent: string
    tweet: Tweet
    alwaysClear: boolean
    currentPanelPrompt?: string
    currentPanelDisplayContent?: string
    quotedSelection?: QuotedSelectionState
    maxTokens?: number
  } | null>(null)

  // 浮动独立对话窗口
  const [floatingChat, setFloatingChat] = useState<{
    initialPrompt: string
    displayContent: string
    sceneMeta: { aiRole: string; context: string }
    initialX: number
    initialY: number
    maxTokens?: number
  } | null>(null)
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const feedScrollRef = useRef<HTMLDivElement>(null)
  useSelectionScrollLock(feedScrollRef)
  const tweetsAbortRef = useRef<AbortController | null>(null)
  const transcriptCallback = useRef<((text: string) => void) | null>(null)
  const keepMenuOpenForReadAloudRef = useRef(false)
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

  // 推文列表 wheel + touch 监听：document 捕获阶段兜底，兼容 DevTools 模拟器与 Mac 触摸板
  useEffect(() => {
    const el = feedScrollRef.current
    if (!el) return

    const hasActiveTextSelection = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim() || sel.rangeCount === 0) return false
      try {
        return el.contains(sel.getRangeAt(0).commonAncestorContainer)
      } catch {
        return false
      }
    }

    const isSelectableTextTarget = (target: EventTarget | null) => {
      return target instanceof Element && target.closest(".select-text") != null
    }

    const scrollFeed = (deltaY: number) => {
      const noOverflow = el.scrollHeight <= el.clientHeight
      const { scrollTop, scrollHeight, clientHeight } = el
      const atTop = scrollTop <= 0 && deltaY < 0
      const atBottom = scrollTop + clientHeight >= scrollHeight && deltaY > 0
      if (noOverflow || atTop || atBottom) return false
      el.scrollTop += deltaY
      return true
    }

    // 惯性滚动：记录速度，松手后平滑减速
    const velocityBuffer: number[] = []
    const pushVelocity = (v: number) => {
      velocityBuffer.push(v)
      if (velocityBuffer.length > 10) velocityBuffer.shift()
    }
    const getVelocity = () => {
      if (velocityBuffer.length === 0) return 0
      const recent = velocityBuffer.slice(-6)
      const avg = recent.reduce((a, x) => a + x, 0) / recent.length
      return avg * 1.3
    }
    let momentumRaf = 0
    const runMomentum = () => {
      let v = getVelocity()
      velocityBuffer.length = 0
      const friction = 0.92
      const minSpeed = 0.5
      const tick = () => {
        if (Math.abs(v) < minSpeed) return
        const { scrollTop, scrollHeight, clientHeight } = el
        const maxScroll = scrollHeight - clientHeight
        if (maxScroll <= 0) return
        let next = scrollTop + v
        if (next <= 0) {
          el.scrollTop = 0
          return
        }
        if (next >= maxScroll) {
          el.scrollTop = maxScroll
          return
        }
        el.scrollTop = next
        v *= friction
        momentumRaf = requestAnimationFrame(tick)
      }
      momentumRaf = requestAnimationFrame(tick)
    }

    const wheelHandler = (e: Event) => {
      const we = e as WheelEvent
      const target = e.target as Node
      let inside = el.contains(target)
      if (!inside && typeof we.clientX === "number") {
        const atPoint = document.elementFromPoint(we.clientX, we.clientY)
        inside = atPoint !== null && el.contains(atPoint)
      }
      if (!inside) return
      const didScroll = scrollFeed(we.deltaY)
      if (didScroll) e.preventDefault()
    }

    let touchStartY = 0
    let touchWasInside = false
    let touchWasOnSelectableText = false
    const touchHandler = (e: TouchEvent) => {
      if (e.type === "touchend") {
        if (touchWasInside && !touchWasOnSelectableText && !hasActiveTextSelection()) runMomentum()
        touchWasOnSelectableText = false
        return
      }
      if (e.touches.length !== 1) return
      const target = e.target as Node
      const touch = e.touches[0]
      let inside = el.contains(target)
      if (!inside && typeof touch.clientX === "number") {
        const atPoint = document.elementFromPoint(touch.clientX, touch.clientY)
        inside = atPoint !== null && el.contains(atPoint)
      }
      touchWasInside = inside
      if (!inside) return
      const touchY = touch.clientY
      if (e.type === "touchstart") {
        touchWasOnSelectableText = isSelectableTextTarget(e.target) || hasActiveTextSelection()
        touchStartY = touchY
        velocityBuffer.length = 0
        cancelAnimationFrame(momentumRaf)
        return
      }
      if (e.type === "touchmove") {
        if (touchWasOnSelectableText || hasActiveTextSelection()) return
        const deltaY = touchStartY - touchY
        touchStartY = touchY
        const didScroll = scrollFeed(deltaY)
        if (didScroll) {
          pushVelocity(deltaY)
        }
        // 在推文列表内时，无论是否发生滚动，都阻止默认行为，避免顶部/底部 overscroll 橡皮筋
        e.preventDefault()
      }
    }

    let mouseStartY = 0
    let isMouseDownOnFeed = false
    let mouseWasOnSelectableText = false
    const mouseDownHandler = (e: MouseEvent) => {
      const target = e.target as Node
      let inside = el.contains(target)
      if (!inside && typeof e.clientX === "number") {
        const atPoint = document.elementFromPoint(e.clientX, e.clientY)
        inside = atPoint !== null && el.contains(atPoint)
      }
      if (!inside) return
      isMouseDownOnFeed = true
      mouseWasOnSelectableText = isSelectableTextTarget(e.target) || hasActiveTextSelection()
      mouseStartY = e.clientY
      velocityBuffer.length = 0
      cancelAnimationFrame(momentumRaf)
    }
    const mouseMoveHandler = (e: MouseEvent) => {
      if (!isMouseDownOnFeed || e.buttons !== 1) return
      if (mouseWasOnSelectableText || hasActiveTextSelection()) return
      const deltaY = mouseStartY - e.clientY
      mouseStartY = e.clientY
      const didScroll = scrollFeed(deltaY)
      if (didScroll) pushVelocity(deltaY)
    }
    const mouseUpHandler = () => {
      if (isMouseDownOnFeed && !mouseWasOnSelectableText && !hasActiveTextSelection()) runMomentum()
      isMouseDownOnFeed = false
      mouseWasOnSelectableText = false
    }

    const opts = { passive: false } as AddEventListenerOptions
    const capture = true
    document.addEventListener("wheel", wheelHandler, { ...opts, capture })
    document.addEventListener("touchstart", touchHandler, { passive: true })
    document.addEventListener("touchmove", touchHandler, opts)
    document.addEventListener("touchend", touchHandler, { passive: true })
    document.addEventListener("mousedown", mouseDownHandler, { capture })
    document.addEventListener("mousemove", mouseMoveHandler, { capture })
    document.addEventListener("mouseup", mouseUpHandler, { capture })
    document.addEventListener("mouseleave", mouseUpHandler, { capture })
    return () => {
      cancelAnimationFrame(momentumRaf)
      document.removeEventListener("wheel", wheelHandler, { ...opts, capture } as EventListenerOptions)
      document.removeEventListener("touchstart", touchHandler)
      document.removeEventListener("touchmove", touchHandler, opts)
      document.removeEventListener("touchend", touchHandler, { passive: true } as EventListenerOptions)
      document.removeEventListener("mousedown", mouseDownHandler, { capture } as EventListenerOptions)
      document.removeEventListener("mousemove", mouseMoveHandler, { capture } as EventListenerOptions)
      document.removeEventListener("mouseup", mouseUpHandler, { capture } as EventListenerOptions)
      document.removeEventListener("mouseleave", mouseUpHandler, { capture } as EventListenerOptions)
    }
  }, [])

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
  const translateTweets = useCallback(async (userName: string, tweets: Tweet[], searchCacheKey?: string) => {
    const account = ACCOUNTS.find((item) => item.userName.toLowerCase() === userName.toLowerCase())
    if (account?.translate === false) return

    const transCache = loadTransCache()
    const needTranslate = tweets.filter((t) => !transCache[t.id])

    const applyTranslations = (updates: Record<string, string>) => {
      if (searchCacheKey) {
        setSearchCache((prev) => {
          const tab = prev[searchCacheKey]
          if (!tab) return prev
          const updated = tab.tweets.map((t) => updates[t.id] ? { ...t, textZh: updates[t.id] } : t)
          return { ...prev, [searchCacheKey]: { ...tab, tweets: updated } }
        })
      } else {
        setCache((prev) => {
          const tab = prev[userName]
          if (!tab) return prev
          const updated = tab.tweets.map((t) => updates[t.id] ? { ...t, textZh: updates[t.id] } : t)
          return { ...prev, [userName]: { ...tab, tweets: updated } }
        })
      }
    }

    // 先把缓存命中的翻译立即填入
    if (Object.keys(transCache).length > 0) {
      applyTranslations(transCache)
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
            applyTranslations({ [id]: textZh })
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
  const loadTweets = useCallback(async (userName: string, cursor?: string, forceRefresh?: boolean) => {
    tweetsAbortRef.current?.abort()
    const controller = new AbortController()
    tweetsAbortRef.current = controller

    const isLoadMore = !!cursor
    if (isLoadMore) setLoadingMore(true); else setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ userName })
      if (cursor) params.set("cursor", cursor)
      if (cursor) {
        const oldestCreatedAt = cache[userName]?.tweets.at(-1)?.createdAt
        if (oldestCreatedAt) params.set("before", oldestCreatedAt)
      }
      if (forceRefresh) params.set("refresh", "1")
      const res = await fetch(`/api/tweets?${params}`, { cache: "no-store", signal: controller.signal })
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const data = await res.json()
      const incoming: Tweet[] = data.tweets ?? []
      setCache((prev) => {
        const existing = prev[userName]?.tweets ?? []
        const tweets = isLoadMore
          ? [...existing, ...incoming.filter((tweet) => !existing.some((item) => item.id === tweet.id))]
          : incoming
        return { ...prev, [userName]: { tweets, hasMore: data.hasMore, nextCursor: data.nextCursor, loadedAt: Date.now() } }
      })
      translateTweets(userName, incoming)
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      if (tweetsAbortRef.current === controller) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [cache, translateTweets])

  // ── 账户内搜索 ──
  const loadSearchResults = useCallback(async (userName: string, query: string, cursor?: string) => {
    const isLoadMore = !!cursor
    if (isLoadMore) setSearchLoadingMore(true); else setSearchLoading(true)
    setSearchError(null)
    const key = `${userName}::${query}`
    try {
      const params = new URLSearchParams({ userName, q: query })
      if (cursor) params.set("cursor", cursor)
      const res = await fetch(`/api/search?${params}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const data = await res.json()
      const incoming: Tweet[] = data.tweets ?? []
      setSearchCache((prev) => {
        const existing = isLoadMore ? (prev[key]?.tweets ?? []) : []
        return { ...prev, [key]: { tweets: [...existing, ...incoming], hasMore: data.hasMore, nextCursor: data.nextCursor } }
      })
      translateTweets(userName, incoming, key)
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : "搜索失败")
    } finally {
      if (isLoadMore) setSearchLoadingMore(false)
      else setSearchLoading(false)
    }
  }, [translateTweets])

  // ── 评论加载 ──
  const loadComments = useCallback(async (tweet: Tweet, cursor?: string) => {
    setCommentsError(null)
    setCommentsLoading(true)

    // 切换到新推文时重置列表
    if (!cursor || commentsForTweet?.id !== tweet.id) {
      setCommentsForTweet(tweet)
      setComments([])
      setAuthorReplies([])
      setCommentsCursor(undefined)
      setCommentsHasMore(false)
    }

    try {
      const params = new URLSearchParams({ id: tweet.id })
      params.set("authorUserName", tweet.author.userName)
      if (cursor) params.set("cursor", cursor)
      const res = await fetch(`/api/tweet-conversation?${params.toString()}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const data = await res.json()
      const incoming: Tweet[] = data.comments ?? []

      setComments((prev) => (cursor && commentsForTweet?.id === tweet.id ? [...prev, ...incoming] : incoming))
      if (!cursor) setAuthorReplies((data.authorReplies ?? []) as Tweet[])
      setCommentsHasMore(Boolean(data.hasMore))
      setCommentsCursor(data.nextCursor as string | undefined)
    } catch (e) {
      setCommentsError(e instanceof Error ? e.message : "加载评论失败")
    } finally {
      setCommentsLoading(false)
    }
  }, [commentsForTweet])

  const loadInlineAuthorReplies = useCallback(async (tweet: Tweet) => {
    if (tweet.replyCount <= 0) {
      setInlineAuthorRepliesByTweet((prev) => ({
        ...prev,
        [tweet.id]: { replies: [], loading: false, loaded: true },
      }))
      return
    }
    if (inlineAuthorRepliesInFlightRef.current.has(tweet.id)) return
    const current = inlineAuthorRepliesByTweet[tweet.id]
    if (current?.loaded || current?.loading) return

    inlineAuthorRepliesInFlightRef.current.add(tweet.id)
    setInlineAuthorRepliesByTweet((prev) => ({
      ...prev,
      [tweet.id]: { replies: prev[tweet.id]?.replies ?? [], loading: true, loaded: false },
    }))

    try {
      const params = new URLSearchParams({
        id: tweet.id,
        authorUserName: tweet.author.userName,
        authorOnly: "1",
      })
      const res = await fetch(`/api/tweet-conversation?${params.toString()}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`Error ${res.status}`)
      const data = await res.json()
      setInlineAuthorRepliesByTweet((prev) => ({
        ...prev,
        [tweet.id]: {
          replies: (data.authorReplies ?? []) as Tweet[],
          loading: false,
          loaded: true,
        },
      }))
    } catch (error) {
      setInlineAuthorRepliesByTweet((prev) => ({
        ...prev,
        [tweet.id]: {
          replies: prev[tweet.id]?.replies ?? [],
          loading: false,
          loaded: true,
          error: error instanceof Error ? error.message : "加载作者回复失败",
        },
      }))
    } finally {
      inlineAuthorRepliesInFlightRef.current.delete(tweet.id)
    }
  }, [inlineAuthorRepliesByTweet])

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

  // Scroll is now managed inside MessageList (smart scroll that respects user position)

  // ── 发送消息（SSE 流式）──
  const sendMessage = useCallback(async (
    text: string,
    options?: {
      tweetOverride?: Tweet
      includeQuotedSelection?: boolean
      displayContent?: string
      quotedSelectionOverride?: QuotedSelectionState
      maxTokens?: number
      alwaysClear?: boolean
    },
  ) => {
    const targetTweet = options?.tweetOverride ?? selectedTweet
    if (!text.trim() || isChatLoading || !targetTweet) return

    const shouldResetMessages = selectedTweet?.id !== targetTweet.id || Boolean(options?.alwaysClear)
    const baseMessages = shouldResetMessages ? [] : messages
    const trimmedText = text.trim()
    const activeQuotedSelection = options?.quotedSelectionOverride ?? (
      options?.includeQuotedSelection === false || shouldResetMessages
        ? null
        : quotedSelection
    )
    const requestText = activeQuotedSelection
      ? buildQuotedFollowUpMessage(trimmedText, activeQuotedSelection)
      : trimmedText
    const userMsg: AiMessage = {
      role: "user",
      content: trimmedText,
      ...(activeQuotedSelection && { quoted: { text: activeQuotedSelection.text } }),
      ...(options?.displayContent && { displayContent: options.displayContent }),
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
          ...(options?.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
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

  const streamAssistantReply = useCallback(
    async (
      apiMessages: { role: "user" | "assistant"; content: string }[],
      tweet: Tweet,
      maxTokens?: number,
    ) => {
      setIsChatLoading(true)
      setSpeechError(null)
      try {
        await streamChatResponse(
          apiMessages,
          buildSceneMeta(tweet),
          () => {
            setIsChatLoading(false)
            setMessages((prev) => [...prev, { role: "assistant", content: "" }])
          },
          (accumulated) => {
            setMessages((prev) => {
              const copy = [...prev]
              copy[copy.length - 1] = { role: "assistant", content: accumulated }
              return copy
            })
          },
          { maxTokens },
        )
      } catch {
        setSpeechError("对话请求失败，请稍后重试")
      } finally {
        setIsChatLoading(false)
      }
    },
    [],
  )

  const handleCommentAnalysis = useCallback(async () => {
    if (!selectedTweet) return
    if (
      isChatLoading ||
      commentAnalysisPrefetching ||
      speechStatus === "recording" ||
      speechStatus === "preparing" ||
      speechStatus === "processing"
    )
      return

    const tweet = selectedTweet
    const tweetId = tweet.id
    const tweetMatches = commentsForTweet?.id === tweetId
    const needFetch = !(tweetMatches && !commentsHasMore)
    const baseHistory = messages

    const shortUser: AiMessage = { role: "user", content: "评论分析", displayContent: "评论分析" }
    setQuotedSelection(null)
    if (isMobile && sheetState === "hidden") setSheetState("half")
    setMessages([...baseHistory, shortUser])
    if (needFetch) setCommentAnalysisPrefetching(true)

    const toApi = (list: AiMessage[]) =>
      list.map((m) => ({ role: m.role, content: m.content }))

    try {
      let finalList: Tweet[]
      let hitCap = false

      if (!needFetch) {
        finalList = authorReplies
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
      } else {
        setCommentsError(null)
        setCommentsLoading(true)
        try {
          const result = await accumulateCommentsForTweet(tweetId, {
            existing: tweetMatches ? comments : [],
            cursor: tweetMatches ? commentsCursor : undefined,
            hasMore: tweetMatches ? commentsHasMore : true,
            tweetMatches,
          }, {
            authorUserName: tweet.author.userName,
          })
          const nextAuthorReplies = tweetMatches ? authorReplies : result.authorReplies
          finalList = nextAuthorReplies
          hitCap = result.hitCap
          setCommentsForTweet(tweet)
          setComments(result.comments)
          if (!tweetMatches) setAuthorReplies(nextAuthorReplies)
          setCommentsHasMore(result.hasMore)
          setCommentsCursor(result.nextCursor)
        } finally {
          setCommentsLoading(false)
        }
      }

      const fullPrompt = buildCommentAnalysisPrompt(tweet, finalList, { hitCap })
      const fullUser: AiMessage = {
        role: "user",
        content: fullPrompt,
        displayContent: "评论分析",
      }
      setMessages([...baseHistory, fullUser])
      setCommentAnalysisPrefetching(false)

      const apiMessages = [...toApi(baseHistory), { role: "user" as const, content: fullPrompt }]
      await streamAssistantReply(apiMessages, tweet, 1800)
    } catch (e) {
      setCommentAnalysisPrefetching(false)
      setMessages(baseHistory)
      setSpeechError(e instanceof Error ? e.message : "加载评论失败")
    }
  }, [
    selectedTweet,
    isChatLoading,
    commentAnalysisPrefetching,
    speechStatus,
    commentsForTweet,
    comments,
    authorReplies,
    commentsHasMore,
    commentsCursor,
    messages,
    isMobile,
    sheetState,
    streamAssistantReply,
  ])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (commentAnalysisPrefetching) return
    sendMessage(inputText)
  }

  const handleVoiceToggle = async () => {
    if (speechStatus === "recording") { whisperSpeechService.stopListening(); return }
    setSpeechError(null)
    try { await whisperSpeechService.startListening() }
    catch { setSpeechError("无法启动录音") }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (
        inputText.trim() &&
        !isChatLoading &&
        !commentAnalysisPrefetching &&
        speechStatus !== "recording" &&
        speechStatus !== "processing"
      )
        sendMessage(inputText)
    }
  }

  const handleSpeechToggle = () => {
    // 语音默认常开，保留空实现以防有地方仍引用
  }

  const closeSelectionMenu = useCallback((clearSelection = false) => {
    keepMenuOpenForReadAloudRef.current = false
    setSelectionMenu(null)
    setPendingSelectionActionId(null)
    setSelectionMenuPhase("actions")
    setPendingWindowChoice(null)
    if (clearSelection) window.getSelection()?.removeAllRanges()
  }, [setSelectionMenuPhase, setPendingWindowChoice])

  const openChatForSelection = useCallback((prompt: string, tweet: Tweet, displayContent?: string, alwaysClear = false, maxTokens?: number) => {
    if (isMobile) setSheetState("half")
    else if (!effectiveChatOpen) setIsChatOpen(true)
    setQuotedSelection(null)
    return sendMessage(prompt, { tweetOverride: tweet, includeQuotedSelection: false, displayContent, alwaysClear, maxTokens })
  }, [effectiveChatOpen, isMobile, sendMessage])

  const handleSynonymClick = useCallback((word: string) => {
    if (!selectedTweet) return
    void openChatForSelection(buildLookupPrompt(word), selectedTweet, `查词：「${word}」`, false, 1500)
  }, [selectedTweet, openChatForSelection])

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
      keepMenuOpenForReadAloudRef.current = true
      try {
        await whisperSpeechService.speak(text)
      } finally {
        setPendingSelectionActionId((current) => current === "readAloud" ? null : current)
      }
      return
    }

    if (selection.source === "tweet" && actionId === "quoteReply") {
      setSelectedTweet(tweet)
      setInputText((current) => mergeDraftText(current, `「${text}」`))
      closeSelectionMenu(true)
      focusChatInput()
      return
    }

    if (selection.source === "assistantReply") {
      if (actionId === "lookup" || actionId === "beginnerSentence" || actionId === "patternMastery") {
        const prompt = SELECTION_ACTIONS[actionId].buildPrompt?.(text, tweet.text)
        if (!prompt) return
        const displayContent = formatSelectionPromptWindowDisplay(actionId, text)
        setSelectionMenuPhase("windowChoice")
        setPendingWindowChoice({ prompt, displayContent, tweet, alwaysClear: false, maxTokens: SELECTION_ACTIONS[actionId].maxTokens })
        return
      }
      if (actionId === "explainReply" || actionId === "translateReply") {
        const quotedSelectionObj: QuotedSelectionState = {
          text,
          sourceRole: "assistant",
          messageIndex: selection.messageIndex ?? messages.length - 1,
          fullMessageContent: selection.fullMessageContent ?? text,
        }
        const newWindowPrompt = actionId === "explainReply"
          ? `请详细解释这段内容的含义，包括语气、背景和关键表达：\n\n「${text}」`
          : `请将以下内容翻译成自然流畅的中文，并解释关键表达：\n\n「${text}」`
        const displayContent = actionId === "explainReply" ? `解释：「${text}」` : `翻译：「${text}」`
        setSelectionMenuPhase("windowChoice")
        setPendingWindowChoice({
          prompt: newWindowPrompt,
          displayContent,
          tweet,
          alwaysClear: false,
          currentPanelPrompt: buildAssistantDraft(actionId),
          currentPanelDisplayContent: actionId === "explainReply" ? "解释这段" : "翻译这段",
          quotedSelection: quotedSelectionObj,
          maxTokens: SELECTION_ACTIONS[actionId].maxTokens,
        })
        return
      }
      // quoteReply
      const quotedSelectionObj: QuotedSelectionState = {
        text,
        sourceRole: "assistant",
        messageIndex: selection.messageIndex ?? messages.length - 1,
        fullMessageContent: selection.fullMessageContent ?? text,
      }
      setQuotedSelection(quotedSelectionObj)
      setInputText((current) => mergeDraftText(current, SELECTION_ACTIONS[actionId].buildDraft?.() ?? ""))
      closeSelectionMenu(true)
      focusChatInput()
      return
    }

    if (actionId === "lookup" || actionId === "beginnerSentence" || actionId === "patternMastery") {
      const prompt = SELECTION_ACTIONS[actionId].buildPrompt?.(text, tweet.text)
      if (!prompt) return
      const displayContent = formatSelectionPromptWindowDisplay(actionId, text)
      setSelectionMenuPhase("windowChoice")
      setPendingWindowChoice({ prompt, displayContent, tweet, alwaysClear: true, maxTokens: SELECTION_ACTIONS[actionId].maxTokens })
      return
    }
    if (actionId === "explainReply" || actionId === "translateReply") {
      const prompt = actionId === "explainReply"
        ? `请详细解释这段内容的含义，包括语气、背景和关键表达：\n\n「${text}」`
        : `请将以下内容翻译成自然流畅的中文，并解释关键表达：\n\n「${text}」`
      const displayContent = actionId === "explainReply" ? `解释：「${text}」` : `翻译：「${text}」`
      setSelectionMenuPhase("windowChoice")
      setPendingWindowChoice({ prompt, displayContent, tweet, alwaysClear: true, maxTokens: SELECTION_ACTIONS[actionId].maxTokens })
      return
    }
    await openChatForSelection(
      SELECTION_ACTIONS[actionId].buildPrompt?.(text, tweet.text) ?? text,
      tweet, undefined, true, SELECTION_ACTIONS[actionId].maxTokens,
    )
  }, [closeSelectionMenu, effectiveChatOpen, focusChatInput, isMobile, messages.length, openChatForSelection, sendMessage, setSelectionMenuPhase, setPendingWindowChoice])

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
  const selectionMenuPhaseRef = useRef(selectionMenuPhase)
  selectionMenuPhaseRef.current = selectionMenuPhase
  useEffect(() => {
    const handleSelectionChange = () => {
      if (!selectionMenuRef.current) return
      const sel = window.getSelection()
      const text = sel?.toString().trim()
      if (!text) {
        if (keepMenuOpenForReadAloudRef.current) return
        if (selectionMenuPhaseRef.current === "windowChoice") return
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
    setSelectedTweet(tweet)
    setMessages([])
    setQuotedSelection(null)
    if (isMobile) setSheetState("half")
    else if (!effectiveChatOpen) setIsChatOpen(true)
  }

  const handleOpenDetail = (tweet: Tweet) => {
    setDetailTweet(tweet)
    setLeftView("detail")
    setSelectedTweet(tweet)
    setMessages([])
    setQuotedSelection(null)
    void loadComments(tweet)
  }

  const handleBackToFeed = () => {
    setDetailTweet(null)
    setLeftView("feed")
  }

  const noTransition = !allowChatTransition || isResizing || justRestoredOpenRef.current
  const primarySelectionActions = selectionMenu ? getPrimaryActions(selectionMenu) : []

  return (
    <div
      className="flex flex-col overflow-hidden relative mobile-bg-scroll bg-fixed w-full max-w-[100vw] min-w-0 h-[var(--app-height)]"
      style={{
        background: "linear-gradient(135deg, #dce8f0 0%, #ede8e0 40%, #e4ece6 100%)",
      }}
    >
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] pointer-events-none z-0" />

      {/* ── Header：始终流式布局，safe-area-top 保证刘海屏正常，sticky 确保手机端可见 ── */}
      <header className="sticky top-0 z-20 shrink-0 bg-white/80 border-b border-gray-200 shadow-sm backdrop-blur-sm pt-[env(safe-area-inset-top)]">
        <div className="px-4 py-2.5 flex items-center gap-3">
          {leftView === "detail" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleBackToFeed}
              className="gap-1 text-gray-600 hover:text-gray-900 shrink-0 -ml-1"
            >
              <ChevronLeft className="h-4 w-4" />
              返回
            </Button>
          )}
          <h1 className="text-xl md:text-lg font-bold text-gray-900 tracking-tight shrink-0">TweetRead</h1>
          {/* Tab 栏 */}
          <div className="flex-1 flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {ACCOUNTS.map((account) => (
              <button
                key={account.userName}
                onClick={() => { setActiveTab(account.userName); setError(null); setLeftView("feed"); setDetailTweet(null); setActiveSearch(""); setSearchQuery(""); setSearchError(null) }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-base md:text-sm font-medium whitespace-nowrap transition-all ${
                  activeTab === account.userName
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100/80 text-gray-600 hover:bg-gray-200/80"
                }`}
              >
                <span className="text-sm md:text-xs opacity-70">@</span>
                {account.userName}
              </button>
            ))}
          </div>
          <div className="flex items-center rounded-md border border-gray-200 overflow-hidden shrink-0">
            <button
              onClick={() => switchViewMode("read")}
              className={`p-1.5 transition-colors ${viewMode === "read" ? "bg-gray-900 text-white" : "text-gray-400 hover:bg-gray-100"}`}
              title="精读模式"
            >
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => switchViewMode("scan")}
              className={`p-1.5 transition-colors ${viewMode === "scan" ? "bg-gray-900 text-white" : "text-gray-400 hover:bg-gray-100"}`}
              title="速览模式"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
          </div>
          <Button
            variant="ghost" size="icon"
            onClick={() => router.push(`/read?user=${activeTab}`)}
            className="text-gray-500 hover:text-gray-900 shrink-0"
            title="从早到晚阅读"
          >
            <BookOpen className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost" size="icon"
            onClick={() => loadTweets(activeTab, undefined, true)}
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

        {/* 左侧：内容区域（推文列表 / 详情页切换） */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden min-w-0">
          {leftView === "feed" ? (
            <>
              {activeAccount.description && (
                <div className="shrink-0 px-4 py-1.5 border-b border-gray-200/60 bg-white/50">
                  <p className="text-sm md:text-xs text-black text-center truncate">{activeAccount.description}</p>
                </div>
              )}
              {/* 搜索栏 */}
              <div className="shrink-0 px-4 py-2 border-b border-gray-200/60 bg-white/50">
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    const q = searchQuery.trim()
                    if (!q) return
                    setActiveSearch(q)
                    loadSearchResults(activeTab, q)
                  }}
                  className="flex items-center gap-2"
                >
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="搜索此账户的推文..."
                      className="w-full pl-8 pr-3 py-1.5 text-sm rounded-full border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300 focus:bg-white transition-all"
                    />
                  </div>
                  {isSearchMode && (
                    <button
                      type="button"
                      onClick={() => { setActiveSearch(""); setSearchQuery(""); setSearchError(null) }}
                      className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800 shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                      清除
                    </button>
                  )}
                </form>
                {isSearchMode && (
                  <p className="mt-1 text-xs text-gray-500">
                    搜索「{activeSearch}」
                    {currentSearch ? `，共 ${currentSearch.tweets.length} 条${currentSearch.hasMore ? "+" : ""}` : ""}
                  </p>
                )}
              </div>
              <div ref={feedScrollRef} className="flex-1 overflow-y-auto overscroll-none hide-vertical-scrollbar min-h-0">
                <div className={viewMode === "scan" ? "w-full" : "max-w-3xl mx-auto"} style={{ paddingBottom: isMobile ? "env(safe-area-inset-bottom, 16px)" : undefined }}>
                  {(isSearchMode ? searchError : error) && (
                    <div className="mx-4 mt-4 p-3 bg-red-50/90 border border-red-200 rounded-lg text-sm text-red-700 flex justify-between items-center">
                      <span>{isSearchMode ? searchError : error}</span>
                      {!isSearchMode && <Button variant="ghost" size="sm" onClick={() => loadTweets(activeTab, undefined, true)}>重试</Button>}
                    </div>
                  )}

                  {(isSearchMode ? searchLoading : loading) && displayTweets.length === 0 && (
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

                  {!(isSearchMode ? searchLoading : loading) && displayTweets.length === 0 && !(isSearchMode ? searchError : error) && (
                    <div className="text-center py-16 text-gray-400 text-sm">
                      {isSearchMode ? `没有找到关于「${activeSearch}」的推文` : "暂无推文"}
                    </div>
                  )}

                  <div className={viewMode === "scan" ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 p-3" : "hidden"}>
                      {displayTweets.map((tweet) => (
                        <button
                          key={tweet.id}
                          onClick={() => handleOpenDetail(tweet)}
                          className="flex flex-col gap-1.5 px-3 py-2.5 bg-white rounded-xl border border-gray-200 hover:border-gray-300 hover:shadow-md text-left transition-all cursor-pointer"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            {tweet.author.profilePicture ? (
                              <img src={tweet.author.profilePicture} alt="" className="h-5 w-5 rounded-full shrink-0 object-cover" />
                            ) : (
                              <div className="h-5 w-5 rounded-full shrink-0 bg-gray-200" />
                            )}
                            <span className="text-xs font-medium text-gray-500 truncate">
                              @{tweet.author.userName}
                            </span>
                            <span className="text-xs text-gray-300 shrink-0">·</span>
                            <span className="text-xs text-gray-400 shrink-0">{formatRelativeTime(tweet.createdAt)}</span>
                          </div>
                          <p className="text-sm leading-snug line-clamp-2 text-gray-800">
                            {tweet.text}
                          </p>
                        </button>
                      ))}
                  </div>
                  <div className={viewMode === "read" ? "divide-y divide-gray-100/80" : "hidden"}>
                    {displayTweets.map((tweet, idx) =>
                      isArticleTweet(tweet) ? (
                        <ArticleCard
                          key={tweet.id}
                          tweet={tweet}
                          index={idx}
                          isSelected={selectedTweet?.id === tweet.id}
                          onAiClick={() => handleOpenAI(tweet)}
                          authorRepliesState={inlineAuthorRepliesByTweet[tweet.id]}
                          onLoadAuthorReplies={() => void loadInlineAuthorReplies(tweet)}
                          isMobile={isMobile}
                          onImageClick={setPreviewImageUrl}
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
                        />
                      ) : (
                        <TweetCard
                          key={tweet.id}
                          tweet={tweet}
                          index={idx}
                          isSelected={selectedTweet?.id === tweet.id}
                          onAiClick={() => handleOpenAI(tweet)}
                          onOpenComments={handleOpenDetail}
                          authorRepliesState={inlineAuthorRepliesByTweet[tweet.id]}
                          onLoadAuthorReplies={() => void loadInlineAuthorReplies(tweet)}
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
                          onImageClick={setPreviewImageUrl}
                        />
                      )
                    )}
                  </div>

                  {displayHasMore && (
                    <div className="flex justify-center py-6">
                      <Button
                        variant="outline" size="sm"
                        onClick={() => {
                          if (isSearchMode) {
                            currentSearch?.nextCursor && loadSearchResults(activeTab, activeSearch, currentSearch.nextCursor)
                          } else {
                            current?.nextCursor && loadTweets(activeTab, current.nextCursor)
                          }
                        }}
                        disabled={isSearchMode ? searchLoadingMore : loadingMore}
                        className="gap-2 bg-white/80 backdrop-blur-sm"
                      >
                        {(isSearchMode ? searchLoadingMore : loadingMore)
                          ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" />加载中...</>
                          : <><ChevronDown className="h-3.5 w-3.5" />加载更多</>}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : detailTweet ? (
            <DetailView
              rootTweet={detailTweet}
              comments={comments}
              authorReplies={authorReplies}
              commentsLoading={commentsLoading}
              commentsError={commentsError}
              commentsHasMore={commentsHasMore}
              onLoadMore={() => commentsForTweet && commentsHasMore && commentsCursor && void loadComments(commentsForTweet, commentsCursor)}
              onAiClick={() => handleOpenAI(detailTweet)}
              onTextSelect={(text, ax, ay) => {
                setPendingSelectionActionId(null)
                setSelectionMenu({
                  text,
                  anchorX: ax,
                  anchorY: ay,
                  tweet: detailTweet,
                  mode: getSelectionMode(text),
                  source: "tweet",
                })
              }}
              isMobile={isMobile}
              style={{ paddingBottom: isMobile ? "env(safe-area-inset-bottom, 16px)" : undefined }}
              onImageClick={setPreviewImageUrl}
            />
          ) : null}
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
            <SynonymClickContext.Provider value={handleSynonymClick}>
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
                onCommentAnalysis={() => void handleCommentAnalysis()}
                commentsLoading={commentsLoading}
                commentAnalysisPrefetching={commentAnalysisPrefetching}
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
                width={mounted ? chatWidth : DEFAULT_CHAT_WIDTH}
                minWidth={mounted ? MIN_CHAT_WIDTH : DEFAULT_CHAT_WIDTH}
                isOpen={effectiveChatOpen}
                noTransition={noTransition}
              />
            </SynonymClickContext.Provider>
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
            <SynonymClickContext.Provider value={handleSynonymClick}>
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
                onExpand={() => setSheetState("full")}
                onSendPreset={(text) => sendMessage(text, { includeQuotedSelection: false })}
                onCommentAnalysis={() => void handleCommentAnalysis()}
                commentsLoading={commentsLoading}
                commentAnalysisPrefetching={commentAnalysisPrefetching}
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
                sheetHeight={sheetHeight}
                isDragging={isDragging}
                sheetState={sheetState}
                onHandleTouchStart={handleSheetDragStart}
                onHandleTouchMove={handleSheetDragMove}
                onHandleTouchEnd={handleSheetDragEnd}
              />
            </SynonymClickContext.Provider>
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
          primaryActions={
            selectionMenuPhase === "windowChoice"
              ? [
                  { id: "choiceCurrentPanel", label: "当前对话" },
                  { id: "choiceNewWindow", label: "新窗口" },
                ]
              : primarySelectionActions
          }
          loadingActionId={pendingSelectionActionId}
          onAction={(actionId) => {
            if (selectionMenuPhase === "windowChoice" && pendingWindowChoice) {
              const { prompt, displayContent, tweet, alwaysClear, currentPanelPrompt, currentPanelDisplayContent, quotedSelection, maxTokens } = pendingWindowChoice
              setSelectionMenuPhase("actions")
              setPendingWindowChoice(null)
              if (actionId === "choiceCurrentPanel") {
                closeSelectionMenu(true)
                if (quotedSelection) {
                  if (isMobile) setSheetState("half")
                  else if (!effectiveChatOpen) setIsChatOpen(true)
                  void sendMessage(currentPanelPrompt ?? prompt, {
                    quotedSelectionOverride: quotedSelection,
                    displayContent: currentPanelDisplayContent,
                    maxTokens,
                  })
                } else {
                  void openChatForSelection(prompt, tweet, displayContent, alwaysClear, maxTokens)
                }
              } else if (actionId === "choiceNewWindow") {
                closeSelectionMenu(true)
                setFloatingChat({
                  initialPrompt: prompt,
                  displayContent,
                  sceneMeta: buildSceneMeta(tweet),
                  initialX: selectionMenu.anchorX,
                  initialY: selectionMenu.anchorY,
                  maxTokens,
                })
              }
              return
            }
            const action = selectionMenu ? SELECTION_ACTIONS[actionId as SelectionActionId] : null
            if (!action || !selectionMenu || pendingSelectionActionId === action.id) return
            void handleSelectionAction(action.id, selectionMenu)
          }}
        />
      )}


      {/* ── 浮动独立对话窗口 ── */}
      {floatingChat && (
        <FloatingChatWindow
          initialPrompt={floatingChat.initialPrompt}
          displayContent={floatingChat.displayContent}
          sceneMeta={floatingChat.sceneMeta}
          initialX={floatingChat.initialX}
          initialY={floatingChat.initialY}
          maxTokens={floatingChat.maxTokens}
          onClose={() => setFloatingChat(null)}
        />
      )}

      {/* ── 图片预览弹窗 ── */}
      {previewImageUrl && (
        <ImagePreviewModal url={previewImageUrl} onClose={() => setPreviewImageUrl(null)} />
      )}

    </div>
  )
}

// ─── DetailView 组件（左侧详情页：推文 + 评论）────────────────────────────────────
type DetailViewProps = {
  rootTweet: Tweet
  comments: Tweet[]
  authorReplies: Tweet[]
  commentsLoading: boolean
  commentsError: string | null
  commentsHasMore: boolean
  onLoadMore: () => void
  onAiClick: () => void
  onTextSelect?: (text: string, anchorX: number, anchorY: number) => void
  isMobile: boolean
  style?: React.CSSProperties
  onImageClick?: (url: string) => void
}

function DetailView({
  rootTweet,
  comments,
  authorReplies,
  commentsLoading,
  commentsError,
  commentsHasMore,
  onLoadMore,
  onAiClick,
  onTextSelect,
  isMobile,
  style,
  onImageClick,
}: DetailViewProps) {
  const readSelection = () => {
    if (!onTextSelect) return
    const anchor = readSelectionAnchor({ maxLength: 800 })
    if (!anchor) return
    onTextSelect(anchor.text, anchor.anchorX, anchor.anchorY)
  }

  const handleMouseUp = () => readSelection()
  const handleTouchEnd = () => {
    if (!isMobile) return
    requestAnimationFrame(() => readSelection())
  }
  return (
    <>
      <div className="flex-1 overflow-y-auto overscroll-none hide-vertical-scrollbar min-h-0">
        <div className="max-w-3xl mx-auto px-4" style={style}>
          {/* 原推文 */}
          <div className="py-4 border-b border-gray-100">
            <div className="flex gap-3">
              <div className="shrink-0">
                {rootTweet.author.profilePicture ? (
                  <Image
                    src={rootTweet.author.profilePicture}
                    alt={rootTweet.author.name}
                    width={40}
                    height={40}
                    className="w-10 h-10 rounded-full object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-sm font-bold">
                    {rootTweet.author.name?.[0] ?? "?"}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5 flex-wrap">
                  <span className="font-semibold text-sm text-gray-900 truncate">{rootTweet.author.name}</span>
                  <span className="text-sm md:text-xs text-gray-400 shrink-0">@{rootTweet.author.userName}</span>
                  <span className="text-sm md:text-xs text-gray-300 shrink-0">·</span>
                  <span className="text-sm md:text-xs text-gray-400 shrink-0">{formatRelativeTime(rootTweet.createdAt)}</span>
                </div>
                <p
                  className="mt-1.5 text-base md:text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-words select-text"
                  onMouseUp={handleMouseUp}
                  onTouchEnd={handleTouchEnd}
                >
                  {smartCase(rootTweet.text)}
                </p>
                {rootTweet.textZh && (
                  <p
                    className="mt-1 text-base md:text-sm text-gray-500 leading-relaxed whitespace-pre-wrap break-words select-text"
                    onMouseUp={handleMouseUp}
                    onTouchEnd={handleTouchEnd}
                  >
                    {rootTweet.textZh}
                  </p>
                )}
                <TweetMediaPreview media={rootTweet.media} onImageClick={onImageClick} />
                <div className="mt-2.5 flex items-center gap-4 text-sm text-gray-400">
                  <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" />{formatCount(rootTweet.likeCount)}</span>
                  <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" />{formatCount(rootTweet.replyCount)}</span>
                  {rootTweet.viewCount > 0 && (
                    <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />{formatCount(rootTweet.viewCount)}</span>
                  )}
                  <button
                    className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-emerald-600 hover:bg-emerald-50 active:scale-95 touch-manipulation transition-transform"
                    onClick={onAiClick}
                    aria-label="推文分析"
                    title="推文分析"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span className="text-sm font-medium">推文分析</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 评论列表 */}
          <div className="py-3">
            <div className="text-sm font-medium text-gray-700 mb-3">作者回复</div>
            {authorReplies.length > 0 && (
              <div className="rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2.5">
                <div className="space-y-3">
                  {authorReplies.map((reply) => (
                    <div key={reply.id} className="flex gap-3 text-sm">
                      <div className="shrink-0">
                        {reply.author.profilePicture ? (
                          <Image
                            src={reply.author.profilePicture}
                            alt={reply.author.name}
                            width={32}
                            height={32}
                            className="w-8 h-8 rounded-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 text-xs font-bold">
                            {reply.author.name?.[0] ?? "?"}
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="font-medium text-gray-900 truncate">{reply.author.name}</span>
                          <span className="text-xs text-gray-400 shrink-0">@{reply.author.userName}</span>
                          <span className="text-xs rounded-full bg-emerald-100 px-1.5 py-0.5 text-emerald-700 shrink-0">作者</span>
                          <span className="text-xs text-gray-300 shrink-0">·</span>
                          <span className="text-xs text-gray-400 shrink-0">{formatRelativeTime(reply.createdAt)}</span>
                        </div>
                        <p
                          className="mt-1 text-gray-800 whitespace-pre-wrap break-words select-text"
                          onMouseUp={handleMouseUp}
                          onTouchEnd={handleTouchEnd}
                        >
                          {smartCase(reply.text)}
                        </p>
                        {reply.textZh && (
                          <p
                            className="mt-1 text-gray-500 whitespace-pre-wrap break-words select-text"
                            onMouseUp={handleMouseUp}
                            onTouchEnd={handleTouchEnd}
                          >
                            {reply.textZh}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="divide-y divide-gray-100">
              {commentsLoading && authorReplies.length === 0 && (
                <div className="py-6 text-center text-xs text-gray-400">加载作者回复中...</div>
              )}
              {!commentsLoading && authorReplies.length === 0 && !commentsError && (
                <div className="py-8 text-center text-xs text-gray-400">暂无作者回复</div>
              )}
              {commentsError && (
                <div className="py-3 text-xs text-red-600 flex items-center justify-between bg-red-50 rounded-lg px-3">
                  <span>{commentsError}</span>
                  <button
                    type="button"
                    className="text-[11px] text-red-600 underline-offset-2 hover:underline"
                    onClick={onLoadMore}
                  >
                    重试
                  </button>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </>
  )
}

// ─── TweetCard 组件 ────────────────────────────────────────────────────────────
function TweetCard({
  tweet, index, isSelected, onTextSelect, onAiClick, onOpenComments, authorRepliesState, onLoadAuthorReplies, isMobile, onImageClick,
}: {
  tweet: Tweet; index: number; isSelected: boolean
  onTextSelect?: (text: string, anchorX: number, anchorY: number) => void
  onAiClick: () => void
  onOpenComments: (tweet: Tweet) => void
  authorRepliesState?: InlineAuthorRepliesState
  onLoadAuthorReplies: () => void
  isMobile: boolean
  onImageClick?: (url: string) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const cardRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (authorRepliesState?.loaded || authorRepliesState?.loading) return
    const node = cardRef.current
    if (!node) return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      onLoadAuthorReplies()
      observer.disconnect()
    }, { rootMargin: "600px 0px" })

    observer.observe(node)
    return () => observer.disconnect()
  }, [authorRepliesState?.loaded, authorRepliesState?.loading, onLoadAuthorReplies])

  const readSelection = () => {
    if (!onTextSelect) return
    const anchor = readSelectionAnchor({ maxLength: 800 })
    if (!anchor) return
    onTextSelect(anchor.text, anchor.anchorX, anchor.anchorY)
    // 不在此处清除 selection，保持高亮让用户看到选中内容
  }

  // 桌面端：mouseup 直接读取 selection
  const handleMouseUp = () => readSelection()

  // 手机端：touchend 后浏览器需要一帧才能将长按 selection 提交给 window.getSelection()
  const handleTouchEnd = () => {
    if (!isMobile) return
    requestAnimationFrame(() => readSelection())
  }

  const shouldShowExpand =
    (tweet.text && tweet.text.length > 140) ||
    (tweet.textZh && tweet.textZh.length > 80)
  const inlineAuthorReplies = authorRepliesState?.replies ?? []

  return (
    <article
      ref={cardRef}
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
            <span className="font-semibold text-base text-gray-900 truncate">{tweet.author.name}</span>
            <span className="text-sm text-gray-400 shrink-0">@{tweet.author.userName}</span>
            <span className="text-sm text-gray-300 shrink-0">·</span>
            <span className="text-sm text-gray-400 shrink-0">{formatRelativeTime(tweet.createdAt)}</span>
          </div>
          <p
            className={`mt-1.5 text-base text-gray-800 leading-relaxed whitespace-pre-wrap break-words select-text ${
              isExpanded ? "" : "line-clamp-6"
            }`}
            onMouseUp={handleMouseUp}
            onTouchEnd={handleTouchEnd}
          >
            {smartCase(tweet.text)}
          </p>
          {tweet.textZh && (
            <p
              className={`mt-1 text-base text-gray-500 leading-relaxed whitespace-pre-wrap break-words select-text ${
                isExpanded ? "" : "line-clamp-4"
              }`}
              onMouseUp={handleMouseUp}
              onTouchEnd={handleTouchEnd}
            >
              {tweet.textZh}
            </p>
          )}
          {shouldShowExpand && (
            <button
              type="button"
              className="mt-1.5 text-xs md:text-[11px] text-emerald-600 hover:text-emerald-700 font-medium"
              onClick={(e) => { e.stopPropagation(); setIsExpanded((prev) => !prev) }}
            >
              {isExpanded ? "收起" : "展开全文"}
            </button>
          )}
          <TweetMediaPreview media={tweet.media} onImageClick={onImageClick} />
          <div className="mt-2.5 flex items-center gap-4 text-sm text-gray-400">
            <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" />{formatCount(tweet.likeCount)}</span>
            <button
              type="button"
              className="flex items-center gap-1 hover:text-emerald-600"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onOpenComments(tweet) }}
            >
              <MessageCircle className="h-3.5 w-3.5" />
              {formatCount(tweet.replyCount)}
            </button>
            {tweet.viewCount > 0 && (
              <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />{formatCount(tweet.viewCount)}</span>
            )}
            <button
              className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-emerald-600 hover:bg-emerald-50 active:scale-95 touch-manipulation transition-transform"
              onClick={(e) => { e.stopPropagation(); onAiClick() }}
              aria-label="推文分析"
              title="推文分析"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="text-sm font-medium">推文分析</span>
            </button>
          </div>
          {inlineAuthorReplies.length > 0 && (
            <div className="mt-3 border-l-2 border-emerald-200 pl-3">
              <div className="mb-1.5 text-xs font-medium text-emerald-700">作者回复</div>
              <div className="space-y-2.5">
                {inlineAuthorReplies.map((reply) => (
                  <div key={reply.id} className="text-sm">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="font-medium text-gray-900 truncate">{reply.author.name}</span>
                      <span className="text-xs text-gray-400 shrink-0">@{reply.author.userName}</span>
                      <span className="text-xs text-gray-300 shrink-0">·</span>
                      <span className="text-xs text-gray-400 shrink-0">{formatRelativeTime(reply.createdAt)}</span>
                    </div>
                    <p
                      className="mt-0.5 text-gray-700 leading-relaxed whitespace-pre-wrap break-words select-text"
                      onMouseUp={handleMouseUp}
                      onTouchEnd={handleTouchEnd}
                    >
                      {smartCase(reply.text)}
                    </p>
                    {reply.textZh && (
                      <p
                        className="mt-0.5 text-gray-500 leading-relaxed whitespace-pre-wrap break-words select-text"
                        onMouseUp={handleMouseUp}
                        onTouchEnd={handleTouchEnd}
                      >
                        {reply.textZh}
                      </p>
                    )}
                    <TweetMediaPreview media={reply.media} onImageClick={onImageClick} compact />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

type CommentsOverlayProps = {
  rootTweet: Tweet
  comments: Tweet[]
  loading: boolean
  error: string | null
  hasMore: boolean
  onLoadMore: () => void
  onClose: () => void
}

function CommentsOverlay({
  rootTweet,
  comments,
  loading,
  error,
  hasMore,
  onLoadMore,
  onClose,
}: CommentsOverlayProps) {
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 px-3">
      <div className="w-full max-w-2xl max-h-[90vh] rounded-2xl bg-white shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <span className="text-sm font-medium text-gray-900">推文评论</span>
          <button
            type="button"
            className="text-xs text-gray-500 hover:text-gray-800"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* 原推文 */}
          <div className="px-4 py-3 border-b border-gray-100">
            <div className="flex gap-3">
              <div className="shrink-0">
                {rootTweet.author.profilePicture ? (
                  <Image
                    src={rootTweet.author.profilePicture}
                    alt={rootTweet.author.name}
                    width={36}
                    height={36}
                    className="w-9 h-9 rounded-full object-cover"
                    unoptimized
                  />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs font-bold">
                    {rootTweet.author.name?.[0] ?? "?"}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5 flex-wrap">
                  <span className="font-semibold text-sm text-gray-900 truncate">{rootTweet.author.name}</span>
                  <span className="text-xs text-gray-400 shrink-0">@{rootTweet.author.userName}</span>
                  <span className="text-xs text-gray-300 shrink-0">·</span>
                  <span className="text-xs text-gray-400 shrink-0">{formatRelativeTime(rootTweet.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap break-words">
                  {smartCase(rootTweet.text)}
                </p>
                {rootTweet.textZh && (
                  <p className="mt-1 text-sm text-gray-500 whitespace-pre-wrap break-words">
                    {rootTweet.textZh}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* 评论列表 */}
          <div className="divide-y divide-gray-100">
            {comments.map((c) => (
              <div key={c.id} className="px-4 py-3 text-sm">
                <div className="flex gap-3">
                  <div className="shrink-0">
                    {c.author.profilePicture ? (
                      <Image
                        src={c.author.profilePicture}
                        alt={c.author.name}
                        width={32}
                        height={32}
                        className="w-8 h-8 rounded-full object-cover"
                        unoptimized
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 text-xs font-bold">
                        {c.author.name?.[0] ?? "?"}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="font-medium text-gray-900 truncate">{c.author.name}</span>
                      <span className="text-xs text-gray-400 shrink-0">@{c.author.userName}</span>
                      <span className="text-xs text-gray-300 shrink-0">·</span>
                      <span className="text-xs text-gray-400 shrink-0">{formatRelativeTime(c.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-gray-800 whitespace-pre-wrap break-words">
                      {smartCase(c.text)}
                    </p>
                    {c.textZh && (
                      <p className="mt-1 text-gray-500 whitespace-pre-wrap break-words">
                        {c.textZh}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {!loading && comments.length === 0 && !error && (
              <div className="px-4 py-8 text-center text-xs text-gray-400">
                暂无评论
              </div>
            )}
            {error && (
              <div className="px-4 py-3 text-xs text-red-600 flex items-center justify-between bg-red-50 border-t border-red-100">
                <span>{error}</span>
                <button
                  type="button"
                  className="text-[11px] text-red-600 underline-offset-2 hover:underline"
                  onClick={onLoadMore}
                >
                  重试
                </button>
              </div>
            )}
          </div>
        </div>

        {hasMore && !error && (
          <div className="border-t border-gray-100 px-4 py-2.5">
            <Button
              size="sm"
              variant="outline"
              disabled={loading}
              className="w-full justify-center gap-2"
              onClick={onLoadMore}
            >
              {loading ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  加载中...
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  加载更多评论
                </>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── ImagePreviewModal 组件 ────────────────────────────────────────────────────
function ImagePreviewModal({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div className="relative" onClick={(e) => e.stopPropagation()}>
        <img
          src={url}
          alt="preview"
          className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
        />
        <button
          onClick={onClose}
          className="absolute top-2 right-2 w-8 h-8 flex items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 text-lg leading-none"
        >
          ×
        </button>
      </div>
    </div>
  )
}

// ─── ArticleCard 组件 ──────────────────────────────────────────────────────────
function applyInlineStyles(text: string, ranges?: Article["contents"][number]["inlineStyleRanges"]): React.ReactNode {
  if (!ranges || ranges.length === 0) return text
  const sorted = [...ranges].sort((a, b) => a.offset - b.offset)
  const nodes: React.ReactNode[] = []
  let pos = 0
  for (const r of sorted) {
    if (r.offset > pos) nodes.push(text.slice(pos, r.offset))
    const chunk = text.slice(r.offset, r.offset + r.length)
    if (r.style === "Bold") nodes.push(<strong key={r.offset}>{chunk}</strong>)
    else if (r.style === "Italic") nodes.push(<em key={r.offset}>{chunk}</em>)
    else nodes.push(chunk)
    pos = r.offset + r.length
  }
  if (pos < text.length) nodes.push(text.slice(pos))
  return <>{nodes}</>
}

function ArticleBlockRenderer({ block, onImageClick }: { block: ArticleBlock; onImageClick?: (url: string) => void }) {
  switch (block.type) {
    case "header-two":
      return <h2 className="text-lg font-bold text-gray-900 mt-4 mb-1">{applyInlineStyles(block.text ?? "", block.inlineStyleRanges)}</h2>
    case "header-three":
      return <h3 className="text-base font-semibold text-gray-900 mt-3 mb-1">{applyInlineStyles(block.text ?? "", block.inlineStyleRanges)}</h3>
    case "blockquote":
      return <blockquote className="border-l-4 border-emerald-400 pl-3 my-2 text-gray-600 italic text-sm">{applyInlineStyles(block.text ?? "", block.inlineStyleRanges)}</blockquote>
    case "ordered-list-item":
      return <li className="ml-5 list-decimal text-sm text-gray-800 leading-relaxed">{applyInlineStyles(block.text ?? "", block.inlineStyleRanges)}</li>
    case "unordered-list-item":
      return <li className="ml-5 list-disc text-sm text-gray-800 leading-relaxed">{applyInlineStyles(block.text ?? "", block.inlineStyleRanges)}</li>
    case "image":
      return block.url ? (
        <div className="my-3 rounded-xl overflow-hidden border border-gray-200/80">
          <img
            src={block.url}
            alt=""
            className="w-full max-h-80 object-cover cursor-pointer"
            loading="lazy"
            onClick={() => onImageClick?.(block.url!)}
          />
        </div>
      ) : null
    case "divider":
      return <hr className="my-4 border-gray-200" />
    default:
      return block.text ? (
        <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-words select-text">
          {applyInlineStyles(block.text, block.inlineStyleRanges)}
        </p>
      ) : null
  }
}

function ArticleCard({
  tweet, index, isSelected, onAiClick, authorRepliesState, onLoadAuthorReplies, isMobile, onImageClick, onTextSelect,
}: {
  tweet: Tweet; index: number; isSelected: boolean
  onAiClick: () => void
  authorRepliesState?: InlineAuthorRepliesState
  onLoadAuthorReplies: () => void
  isMobile: boolean
  onImageClick?: (url: string) => void
  onTextSelect?: (text: string, anchorX: number, anchorY: number) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [article, setArticle] = useState<Article | null>(null)
  const [articleLoading, setArticleLoading] = useState(false)
  const [articleError, setArticleError] = useState<string | null>(null)
  const cardRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (authorRepliesState?.loaded || authorRepliesState?.loading) return
    const node = cardRef.current
    if (!node) return

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      onLoadAuthorReplies()
      observer.disconnect()
    }, { rootMargin: "600px 0px" })

    observer.observe(node)
    return () => observer.disconnect()
  }, [authorRepliesState?.loaded, authorRepliesState?.loading, onLoadAuthorReplies])

  const readSelection = () => {
    if (!onTextSelect) return
    const anchor = readSelectionAnchor({ maxLength: 800 })
    if (!anchor) return
    onTextSelect(anchor.text, anchor.anchorX, anchor.anchorY)
  }

  const handleExpand = async () => {
    if (expanded) { setExpanded(false); return }
    setExpanded(true)
    if (article || articleLoading) return
    setArticleLoading(true)
    setArticleError(null)
    try {
      const res = await fetch(`/api/articles/${tweet.id}`)
      if (!res.ok) throw new Error("加载失败")
      const data = await res.json() as { article: Article }
      setArticle(data.article)
    } catch (e) {
      setArticleError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setArticleLoading(false)
    }
  }

  const displayTitle = article?.title ?? ""
  const displayPreview = article?.previewText ?? ""
  const inlineAuthorReplies = authorRepliesState?.replies ?? []

  return (
    <article
      ref={cardRef}
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
            <span className="font-semibold text-base text-gray-900 truncate">{tweet.author.name}</span>
            <span className="text-sm text-gray-400 shrink-0">@{tweet.author.userName}</span>
            <span className="text-sm text-gray-300 shrink-0">·</span>
            <span className="text-sm text-gray-400 shrink-0">{formatRelativeTime(tweet.createdAt)}</span>
            <span className="ml-1 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">文章</span>
          </div>

          {/* 封面图 + 标题预览卡片 */}
          <button
            type="button"
            className="mt-2 w-full text-left rounded-xl border border-gray-200/80 overflow-hidden bg-gray-50 hover:bg-gray-100/80 transition-colors"
            onClick={handleExpand}
          >
            {tweet.media.length > 0 && tweet.media[0].url ? (
              <img src={tweet.media[0].url} alt="" className="w-full max-h-40 object-cover" loading="lazy" />
            ) : null}
            <div className="px-3 py-2.5">
              {articleLoading && !displayTitle ? (
                <div className="h-4 bg-gray-200 rounded animate-pulse w-3/4" />
              ) : displayTitle ? (
                <p className="font-semibold text-sm text-gray-900 leading-snug line-clamp-2">{displayTitle}</p>
              ) : (
                <p className="text-xs text-gray-400">点击加载文章</p>
              )}
              {displayPreview && !expanded && (
                <p className="mt-1 text-xs text-gray-500 line-clamp-2 leading-relaxed">{displayPreview}</p>
              )}
              <p className="mt-1.5 text-xs text-emerald-600 font-medium">{expanded ? "收起" : "阅读全文"}</p>
            </div>
          </button>

          {/* 展开的文章正文 */}
          {expanded && (
            <div
              className="mt-3 space-y-2"
              onMouseUp={isMobile ? undefined : readSelection}
              onTouchEnd={isMobile ? () => requestAnimationFrame(readSelection) : undefined}
            >
              {articleLoading && (
                <div className="space-y-2">
                  {[1,2,3].map(i => <div key={i} className="h-3 bg-gray-200 rounded animate-pulse" style={{ width: `${70 + i * 8}%` }} />)}
                </div>
              )}
              {articleError && <p className="text-xs text-red-500">{articleError}</p>}
              {article && article.contents.map((block, i) => (
                <ArticleBlockRenderer key={i} block={block} onImageClick={onImageClick} />
              ))}
            </div>
          )}

          <div className="mt-2.5 flex items-center gap-4 text-sm text-gray-400">
            <span className="flex items-center gap-1"><Heart className="h-3.5 w-3.5" />{formatCount(tweet.likeCount)}</span>
            <span className="flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" />{formatCount(tweet.replyCount)}</span>
            {tweet.viewCount > 0 && (
              <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" />{formatCount(tweet.viewCount)}</span>
            )}
            <button
              className="ml-auto inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-emerald-600 hover:bg-emerald-50 active:scale-95 touch-manipulation transition-transform"
              onClick={(e) => { e.stopPropagation(); onAiClick() }}
              aria-label="推文分析"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span className="text-sm font-medium">推文分析</span>
            </button>
          </div>
          {inlineAuthorReplies.length > 0 && (
            <div className="mt-3 border-l-2 border-emerald-200 pl-3">
              <div className="mb-1.5 text-xs font-medium text-emerald-700">作者回复</div>
              <div className="space-y-2.5">
                {inlineAuthorReplies.map((reply) => (
                  <div key={reply.id} className="text-sm">
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      <span className="font-medium text-gray-900 truncate">{reply.author.name}</span>
                      <span className="text-xs text-gray-400 shrink-0">@{reply.author.userName}</span>
                      <span className="text-xs text-gray-300 shrink-0">·</span>
                      <span className="text-xs text-gray-400 shrink-0">{formatRelativeTime(reply.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                      {smartCase(reply.text)}
                    </p>
                    {reply.textZh && (
                      <p className="mt-0.5 text-gray-500 leading-relaxed whitespace-pre-wrap break-words">
                        {reply.textZh}
                      </p>
                    )}
                    <TweetMediaPreview media={reply.media} onImageClick={onImageClick} compact />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}
