export interface MarketData {
    creator: string
    deadline: bigint
    feeBps: number
    status: number
    outcome: number
    poolYes: bigint
    poolNo: bigint
    category: number
    manipulationScore: number
    totalVolume: bigint
    question: string
    bettorCount: bigint
}

export interface BetInfo {
    marketId: bigint
    bettor: string
    isYes: boolean
    amount: bigint
    shares: bigint
    feeAmount: bigint
}

export interface AiAnalysis {
    manipulationScore: number
    reason: string
    patterns_matched: string[]
    recommendation: 'safe' | 'monitor' | 'flag'
}
