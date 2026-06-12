import postgres from "postgres"

// Vercel 用 pooler URL（端口 6543），本地脚本用 direct URL（端口 5432）均可
const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("DATABASE_URL is not set")

// max: 1 适合 Serverless 环境，避免连接数超限
const sql = postgres(connectionString, { max: 1 })

export default sql
