export interface WorkflowInput {
	inputType: 'manual' | 'social_post'
	question?: string
	tweetText?: string
	creator: string
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
