/** Public contact and bonus notice options shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** Questionnaire destination and bonus notice timings shared by Host and Client. */
export interface ContactConfig {
  /** HTTPS questionnaire URL; override for a test form. */
  contactFormUrl: string
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: string
  /** 只有明确启用时，反馈链接才携带账号和设备信息。 */
  contactIncludeContext: boolean
  /** First delay before retrying a failed bonus acknowledgement. */
  bonusAckRetryDelayMs: number
  /** Ceiling for the acknowledgement retry backoff. */
  bonusAckRetryMaxDelayMs: number
}
/** Validate public questionnaire options. */
export const ContactConfigFields = {
  contactFormUrl: z.string().pattern(/^https:\/\/[^/\s]+\//).default('https://github.com/zhuhanxin0308/freecode/issues/new'),
  contactSource: z.string().default(''),
  contactIncludeContext: z.boolean().default(false),
  bonusAckRetryDelayMs: z.number().min(1).default(1_000),
  bonusAckRetryMaxDelayMs: z.number().min(1).default(60_000),
}
/** Validate public questionnaire options. */
export const ContactConfig: z<Partial<ContactConfig>, ContactConfig> = z.object(ContactConfigFields)
/** Bootstrap key containing no account credentials. */
export const CONTACT_CONFIG_GLOBAL = '__DSH_CONTACT_CONFIG__'
