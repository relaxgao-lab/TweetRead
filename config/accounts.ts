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
  {
    userName: "Polymarket",
    displayName: "Polymarket",
    description: "Prediction markets on elections, crypto, and world events.",
    aiContext: "This is the official Polymarket account for prediction markets. It posts about market odds, event outcomes, election predictions, crypto prices, and other forecastable events. Content is often data-driven with implied probabilities.",
  },
  {
    userName: "aleabitoreddit",
    displayName: "Aleabit On Reddit",
    description: "Reddit-style commentary and curation on markets and tech news.",
    aiContext: "This account curates and comments on market and technology discussions from Reddit-style communities, often adding short opinions or context.",
  },
  {
    userName: "zarazhangrui",
    displayName: "Zara Zhangrui",
    description: "Chinese-language insights on global markets and macro trends.",
    aiContext: "This account posts Chinese-language takes on global financial markets, macro trends, and important policy or economic events, often mixing English tickers with Chinese commentary.",
  },
 
  // 添加更多账号：
  // {
  //   userName: "elonmusk",
  //   displayName: "Elon Musk",
  //   description: "Tech & business updates",
  // },
]
