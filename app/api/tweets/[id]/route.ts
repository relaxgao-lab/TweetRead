import { NextResponse } from "next/server"
import { fetchTweetById } from "@/lib/twitter"

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const { id } = params
  if (!id) return NextResponse.json({ error: "请求参数错误，缺少推文 ID" }, { status: 400 })

  try {
    const tweet = await fetchTweetById(id)
    if (!tweet) return NextResponse.json({ error: "推文不存在或已被删除" }, { status: 404 })
    return NextResponse.json({ tweet })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "服务内部错误"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
