/** 用户意图按模型原生尺寸匹配，实际输出尺寸始终可见。 */
import { expect, it } from 'vitest'
import { chooseImageSize, imageRatio, imageResolution } from '../src/client/image-sizing.ts'

it('支持横竖原生 4K，不把超过像素上限的方图伪装为 4K', () => {
  const sizes = ['1024x1024', '2048x2048', '2880x2880', '1536x864', '2560x1440', '3840x2160', '2160x3840']
  expect(chooseImageSize(sizes, '4k', '16:9')).toEqual({ size: '3840x2160', adjusted: false })
  expect(chooseImageSize(sizes, '4k', '9:16')).toEqual({ size: '2160x3840', adjusted: false })
  expect(chooseImageSize(sizes, '4k', '1:1')).toEqual({ size: '2880x2880', adjusted: true })
})

it('切换到能力较低的模型时保留接近的构图并报告调整', () => {
  expect(chooseImageSize(['1024x1024', '1536x1024', '1024x1536'], '4k', '16:9'))
    .toEqual({ size: '1536x1024', adjusted: true })
  expect(chooseImageSize(['auto'], '2k', '1:1')).toEqual({ size: 'auto', adjusted: true })
  expect(chooseImageSize([], '1k', '1:1')).toEqual({ size: '', adjusted: true })
  expect(imageRatio('1024x1536')).toBe('2:3')
  expect(imageRatio('auto')).toBe('1:1')
  expect(imageResolution('2048x2048')).toBe('2k')
  expect(imageResolution('3840x2160')).toBe('4k')
  expect(imageResolution('auto')).toBe('1k')
  expect(chooseImageSize(['0x1024'], '1k', '1:1')).toEqual({ size: '0x1024', adjusted: true })
})
