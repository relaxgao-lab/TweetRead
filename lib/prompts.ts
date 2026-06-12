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
2. 基本释义：先分别给出这个词或短语最常见释义：中文释义和英文释义
3. 语境义：再说明它在这条推文里的自然含义
4. 用法提示：语气、搭配、感情色彩、隐含意思，或为什么这样用
5. 常见误区：容易按字面误解，或容易和别的表达混淆时提醒
6. 英文例句：1个简短自然的例句（15词以内），附中文翻译
7. 近义词标签：在回复的最后一行，仅输出 2～4 个这个语境里可替换的英文单词或短语，严格使用以下格式，不要任何前缀、标题或标点，只输出这一行：
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

export function buildWritingStylePrompt(text: string, tweetText?: string): string {
  const tweetBlock = tweetText ? `推文原文（上下文参考）：\n「${tweetText}」\n\n` : ""

  return `${tweetBlock}请解析我在这条推文里选中的英文写法：「${text}」

我的目标是：既能读懂真实推文里的非正式、压缩、口语化英文，也能知道更标准、更完整的英文应该怎么写。

请严格按以下顺序，尽量简洁：

1. 原文写法：原样写出选中的内容
2. 这是什么写法：判断它属于省略、口语表达、推文压缩、行业速记、倒装、断句、非标准语法，还是标准但不常见的写法
3. 为什么这样写：解释作者为什么会这样写，比如为了简短、语气自然、承接上一句、突出重点、制造节奏，或符合 Twitter / 金融圈表达习惯
4. 标准英文写法：改写成 1 个语法完整、自然清晰的标准英文版本
5. 对照拆解：用简短 bullet 对比原文写法和标准写法，指出省略、补全、语序或表达变化
6. 学习提醒：最后用 1 句话告诉我以后看到类似写法时应该怎么判断

补充要求：
- 回答主体用中文，保留关键英文表达
- 不要简单判定为"错误"，要区分真实错误、口语省略、推文压缩和行业表达
- 标准英文写法要自然，不要改成生硬的教科书句子
- 必须结合推文上下文解释，不要脱离当前推文语境
- 不要长篇大论，像老师帮学生把真实推文还原成标准英文`
}
