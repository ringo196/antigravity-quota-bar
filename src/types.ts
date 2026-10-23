export type WindowType = 'daily' | 'weekly' | 'other';

export interface QuotaBucket {
  window: WindowType;
  remainingFraction: number; // 0.0 to 1.0
  resetTime?: Date;
  rawWindow?: string;
  description?: string;
}

export interface PoolQuota {
  id: 'gemini' | 'gpt' | 'argon' | string;
  label: string;
  shortLabel: string;
  daily?: QuotaBucket;
  weekly?: QuotaBucket;
  isAvailable: boolean;
}

export interface QuotaSummary {
  pools: PoolQuota[];
  updatedAt: Date;
  source: 'RetrieveUserQuotaSummary' | 'GetUserStatus' | 'mock';
}

export interface ServerConnection {
  port: number;
  csrfToken: string;
  isHttps: boolean;
  pid: number;
}

