import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const MODEL_ID = "gpt-5.4-nano-2026-03-17"

interface Message {
  role: "user" | "assistant" | "system"
  content: string
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { messages, sceneMeta, maxTokens: rawMax } = body as {
      messages?: unknown
      sceneMeta?: { aiRole?: string; context?: string }
      maxTokens?: number
    }

    if (!sceneMeta?.aiRole || !sceneMeta?.context) {
      return new Response(JSON.stringify({ error: "Missing sceneMeta" }), { status: 400 })
    }

    const systemPrompt = `You are ${sceneMeta.aiRole}. Your job is to help the user understand the following tweet content.

Tweet content:
${sceneMeta.context}

Guidelines:
1. Be concise and helpful. Answer directly.
2. When explaining background or context, use clear and simple language.
3. If asked to translate, translate accurately and naturally into Chinese.
4. If asked to summarize, highlight the key points.
5. Always stay focused on the tweet content provided.
6. If the user pastes a list of replies under the tweet, synthesize main viewpoints and themes; do not quote every reply in full.
7. Respond in Chinese unless the user explicitly asks for English.`

    const filteredMessages = Array.isArray(messages)
      ? (messages as Message[]).filter((m): m is Message & { role: "user" | "assistant" } => m.role !== "system")
      : []

    const maxOut =
      typeof rawMax === "number" && Number.isFinite(rawMax)
        ? Math.min(Math.max(1, Math.floor(rawMax)), 4000)
        : 2000

    // gpt-5 / o-series 这类带 reasoning 的模型只认 max_completion_tokens
    const stream = await openai.chat.completions.create({
      model: MODEL_ID,
      stream: true,
      max_completion_tokens: maxOut,
      messages: [
        { role: "system", content: systemPrompt },
        ...filteredMessages.map((m) => ({ role: m.role, content: m.content })),
      ],
    })

    const encoder = new TextEncoder()
    const readable = new ReadableStream({
      async start(controller) {
        let truncated = false
        try {
          for await (const chunk of stream) {
            const choice = chunk.choices?.[0]
            const delta = choice?.delta?.content
            if (delta) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`)
              )
            }
            if (choice?.finish_reason === "length") {
              truncated = true
            }
          }
          if (truncated) {
            const notice = "\n\n_（回答已达长度上限，如需继续请回复「继续」或提更具体的问题）_"
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ delta: notice })}\n\n`)
            )
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        } finally {
          controller.close()
        }
      },
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error"
    console.error("Chat API error:", msg)
    return new Response(JSON.stringify({ error: `Failed to get AI response: ${msg}` }), { status: 500 })
  }
}
