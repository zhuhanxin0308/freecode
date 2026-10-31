/** 图片服务错误只向客户端公开固定分类。 */
import type { ImageErrorCode } from '../types.ts'

/** 业务失败，不保留供应商密钥、请求地址或原始错误正文。 */
export class ImageFailure extends Error {
  /**
   * 建立不携带供应商正文或凭据的失败。
   * @param code - 客户端可本地化的失败分类。
   * @param uncertain - 供应商可能已接受请求。
   */
  constructor(readonly code: ImageErrorCode, readonly uncertain = false) { super(code); this.name = 'ImageFailure' }
}

/**
 * 隐藏未分类内部异常的细节。
 * @param error - 内部失败。
 * @returns 可公开的失败分类。
 */
export function imageFailureCode(error: unknown): ImageErrorCode {
  return error instanceof ImageFailure ? error.code : 'upstream-unavailable'
}
