export type StargazersData = {
  length: number
  headers: {
    link?: string
  }
  status: number
  starred_at: string
}

export type StarRecord = {
  date: string
  count: number
}

export type ForkRecord = StarRecord

export type ForksData = {
  length: number
  headers: {
    link?: string
  }
  status: number
  created_at: string
}

export type IssueRecord = StarRecord

export type IssueData = ForksData

export type TimeFrame = 'day' | 'week' | 'month' | '3 month' | '6 month' | 'year'

export type HistoryType = 'issue' | 'star' | 'fork'
