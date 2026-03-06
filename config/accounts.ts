export interface TwitterAccount {
  userName: string
  displayName: string
  description: string
  // AI 解读角色定制（可选）
  aiContext?: string
}

export const ACCOUNTS: TwitterAccount[] = [
  {
    userName: "DeItaone",
    displayName: "Delta One",
    description: "Market news & financial intelligence",
    aiContext: "This is a financial market news account that posts rapid-fire market headlines, economic data releases, and breaking financial news.",
  },
  // 添加更多账号：
  // {
  //   userName: "elonmusk",
  //   displayName: "Elon Musk",
  //   description: "Tech & business updates",
  // },
]
