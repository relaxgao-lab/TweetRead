export function isWordOrPhraseLookup(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ")
  if (!normalized) return true
  const wordCount = normalized.split(" ").length
  const hasStrongSentencePunctuation = /[.!?;:]/.test(normalized)
  const hasClauseSignal = /,|\bthat\b|\bwhich\b|\bwho\b|\bwhen\b|\bwhile\b|\bif\b|\bbecause\b|\bbut\b|\band\b/i.test(normalized)
  return wordCount <= 4 && !hasStrongSentencePunctuation && !hasClauseSignal
}

export function buildLookupPrompt(text: string, tweetText?: string): string {
  const tweetBlock = tweetText ? `推文原文（上下文参考）：\n「${tweetText}」\n\n` : ""

  if (isWordOrPhraseLookup(text)) {
    return `${tweetBlock}请解释我在这条推文里选中的这个英文单词或短语：「${text}」

这次请使用"英语词典讲解"风格，目标是帮助中文用户真正学会它，而不是只看中文翻译。

请严格按以下顺序，尽量简洁：

1. 原词 / 原短语：原样写出，标注音标（IPA，如 /ˈeksəmpəl/），并标注词性（n. / v. / adj. 等）
2. 语境义：它在这条推文里的自然含义
3. 用法提示：语气、搭配、感情色彩、隐含意思，或为什么这样用
4. 常见误区：容易按字面误解，或容易和别的表达混淆时提醒
5. 英文例句：1个简短自然的例句（15词以内），附中文翻译
6. 近义词标签：在回复的最后一行，仅输出 2～4 个这个语境里可替换的英文单词或短语，严格使用以下格式，不要任何前缀、标题或标点，只输出这一行：
[word1]{synonym} [word2]{synonym} [phrase]{synonym}

补充要求：
- 回答主体用中文，保留关键英文表达
- 单词或短语必须标注音标（IPA），方便用户知道如何发音
- 如果是俚语、缩写、梗、固定搭配或带语气的说法，直接点明
- 不要展开成长篇文章，像老师讲词汇重点一样简洁
- 必须结合推文上下文解释语境义，不要只给词典式死定义`
  }

  return `${tweetBlock}请解释我在这条推文里选中的这句或这段英文：「${text}」。

这次请使用"英语精读拆解"风格，目标是帮助中文用户真正读懂句子结构、语气和表达方式，而不是只给整句翻译。

请严格按这个顺序组织，尽量简洁：
1. 原句 / 原文：原样写出
2. 整体句意：先用自然中文说清整句在这条推文里的意思
3. 精读拆解：按意群或短语分块解释，每一块都说明它在这里表达什么
4. 表达重点：指出这句里最值得学习的 1 到 3 个表达、搭配或句式
5. 语气 / 弦外之音：如果有强调、调侃、反讽、省略、口语感、网络语气，也说明一下
6. 学习收获：最后用一句话总结"这句英文最值得记住的地方"

补充要求：
- 回答主体用中文，但保留关键英文表达
- 不要逐词硬译，要优先解释真实语境
- 如果字面义和真实语境义不同，要点明
- 不要长篇大论，像老师带着学生做一句精读
- 必须结合推文上下文解释，不要脱离当前推文语境`
}
