export interface WorkflowInput {
	inputType: 'manual' | 'social_post'
	question?: string
	tweetText?: string
	creator: string
	/** proposalId from proposeMarket (user $5 deposit). Required for create market. */
	proposalId: number | string
}

export interface AIAnalysis {
	resolvable: boolean
	category: string
	refinedQuestion: string
	resolutionCriteria: string
	dataSources: string[]
	riskScore: number
	riskReason: string
	suggestedDeadline: string
	targetValue: number | null
	priceFeedAddress: string | null
	asset?: string // e.g. "ETH", "BTC" — for CRYPTO, used to lookup price feed
}

export interface WorkflowResult {
	status: 'created' | 'pending' | 'rejected'
	txHash?: string
	marketCategory?: string
	refinedQuestion?: string
	resolutionCriteria?: string
	dataSources?: string[]
	riskScore?: number
	riskReason?: string
	suggestedDeadline?: string
	reason?: string
}
