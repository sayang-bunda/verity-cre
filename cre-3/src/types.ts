export interface MarketInfo {
    category: number
    status: number
    deadline: bigint
    question: string
}

export interface ResolutionData {
    resolutionCriteria: string
    dataSources: string
    targetValue: bigint
    priceFeedAddress: string
}

export interface ResolutionResult {
    outcome: number    // 1=YES, 2=NO
    confidence: number // 0–100
    reason: string
    evidenceUrls: string[]  // news article URLs for on-chain evidence
}

export interface AiResolution {
    outcome: number
    confidence: number
    reason: string
    evidence: string[]  // AI explanation points
    evidenceUrls: string[]  // source URLs
}
