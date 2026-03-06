import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: Request) {
  const { text, context } = await request.json() as { text: string; context?: string }
  if (!text?.trim()) {
    return Response.json({ error: "Missing text" }, { status: 400 })
  }

  const isWord = text.trim().split(/\s+/).length <= 2

  const prompt = isWord
    ? `You are an English teacher helping Chinese beginners learn English. For the word/phrase "${text}", provide all of the following in Chinese where applicable:
${context ? `Context: "${context}"\n` : ""}
Reply in this exact JSON (no markdown, no extra keys):
{
  "phonetic": "IPA transcription",
  "partOfSpeech": "词性, e.g. n./v./adj./adv./prep.",
  "translation": "简明中文释义（结合语境，1-5词）",
  "definition": "中文详细解释，说明该词在此语境中的含义（1-2句）",
  "example": "一个自然的英文例句",
  "exampleZh": "例句的中文翻译"
}`
    : `You are an English teacher helping Chinese beginners. Explain the phrase or sentence "${text}" in detail.
${context ? `Full context: "${context}"\n` : ""}
Reply in this exact JSON (no markdown, no extra keys):
{
  "translation": "准确的中文翻译",
  "breakdown": "逐词/逐块拆解，格式：词1（释义） + 词2（释义）+ ...",
  "grammar": "语法或用法说明，解释关键结构或搭配（1-2句）",
  "example": "一个类似结构的自然英文例句",
  "exampleZh": "例句的中文翻译"
}`

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini-2025-04-14",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 350,
    })
    const raw = (completion.choices[0].message.content ?? "{}").replace(/```json\s*/g, "").replace(/```/g, "").trim()
    return Response.json(JSON.parse(raw))
  } catch (err) {
    console.error("lookup error:", err)
    return Response.json({ translation: "查询失败", explanation: "" }, { status: 500 })
  }
}
