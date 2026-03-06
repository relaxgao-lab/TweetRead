import OpenAI from "openai"

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export async function POST(request: Request) {
  const { items } = await request.json() as { items: { id: string; text: string }[] }
  if (!items?.length) {
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
  }

  const prompt = `Translate each tweet from English to Chinese. Output ONLY the translations, one per line, in the same order as the input. No numbering, no extra text.

${items.map((item, i) => `${i + 1}. ${item.text}`).join("\n")}`

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini-2025-04-14",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 2000,
          stream: true,
        })

        let buffer = ""
        let lineIndex = 0

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content ?? ""
          buffer += delta

          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""

          for (const line of lines) {
            const cleaned = line.replace(/^\d+\.\s*/, "").trim()
            if (cleaned && lineIndex < items.length) {
              const event = `data: ${JSON.stringify({ id: items[lineIndex].id, index: lineIndex, textZh: cleaned })}\n\n`
              controller.enqueue(encoder.encode(event))
              lineIndex++
            }
          }
        }

        // flush last line if no trailing newline
        if (buffer.trim() && lineIndex < items.length) {
          const cleaned = buffer.replace(/^\d+\.\s*/, "").trim()
          if (cleaned) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: items[lineIndex].id, index: lineIndex, textZh: cleaned })}\n\n`))
          }
        }
      } catch (err) {
        console.error("translate SSE error:", err)
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  })
}
