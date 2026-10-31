/** 图片提供商表单的双语文案。 */
export const imageEn = {
  imageCompressionParameter: 'Supports compression quality', imageModerationParameter: 'Supports moderation level', imageFidelityParameter: 'Supports reference fidelity',
  providerPurpose: 'Provider purpose', purposeChat: 'Chat models', purposeImages: 'Image generation',
  chatModelsEnabled: 'Enable chat models', imageModels: 'Image models',
  imageModelsHint: 'Uses this provider’s address and saved credentials. Declare only options confirmed by the provider; model IDs alone do not describe image capabilities.',
  imageModelsEmpty: 'No image models configured for this provider.',
  addImageModel: 'Add image model', removeImageModel: 'Delete image model',
  imageModelId: 'Image model ID', imageModelName: 'Image model display name',
  imageSizes: 'Supported sizes', imageSizesPlaceholder: '1024x1024, 1536x1024',
  imageListHint: 'Separate confirmed options with commas. Use auto only when the provider supports it.',
  imageQualities: 'Supported quality levels', imageQualityParameter: 'Supports a quality option',
  imageBackgroundParameter: 'Supports background options', imageFormatParameter: 'Supports an output format option',
  imageBackgrounds: 'Supported backgrounds', imageBackgroundAuto: 'Automatic', imageBackgroundOpaque: 'Opaque', imageBackgroundTransparent: 'Transparent',
  imageFormats: 'Output formats', imageSupportsEdit: 'Supports editing reference images', imageSupportsMask: 'Supports masked editing',
  imageReferenceLimit: 'Maximum reference images', imageNeedsModel: 'Add at least one image model and its supported sizes.',
  imageSizesInvalid: 'Enter supported sizes as width×height using x, or auto.',
  imageCapabilitiesInvalid: 'Choose at least one supported option in every capability group.',
  imageReferenceInvalid: 'The reference image limit must be a positive whole number.',
  imageTransparencyInvalid: 'Transparent backgrounds require PNG or WebP.', imageReset: 'Restore inherited image models',
} as const

/** 与英文键集一致的中文图片表单文案。 */
export const imageZh: Record<keyof typeof imageEn, string> = {
  imageCompressionParameter: '支持压缩质量', imageModerationParameter: '支持内容审核等级', imageFidelityParameter: '支持参考图保真度',
  providerPurpose: '提供商用途', purposeChat: '聊天模型', purposeImages: '图片生成',
  chatModelsEnabled: '启用聊天模型', imageModels: '图片模型',
  imageModelsHint: '复用此提供商的服务地址和已保存凭据。请填写服务商明确支持的选项，模型名称本身不能说明图片能力',
  imageModelsEmpty: '此提供商尚未配置图片模型', addImageModel: '添加图片模型', removeImageModel: '删除图片模型',
  imageModelId: '图片模型标识', imageModelName: '图片模型显示名称',
  imageSizes: '支持的尺寸', imageSizesPlaceholder: '1024x1024, 1536x1024',
  imageListHint: '用逗号分隔已确认支持的选项；仅在服务商支持时填写 auto',
  imageQualities: '支持的画质', imageQualityParameter: '支持画质选项', imageBackgroundParameter: '支持背景选项', imageFormatParameter: '支持指定输出格式',
  imageBackgrounds: '支持的背景', imageBackgroundAuto: '自动', imageBackgroundOpaque: '不透明', imageBackgroundTransparent: '透明',
  imageFormats: '输出格式', imageSupportsEdit: '支持参考图编辑', imageSupportsMask: '支持局部重绘', imageReferenceLimit: '最多参考图片数',
  imageNeedsModel: '请添加至少一个图片模型，并填写支持的尺寸', imageSizesInvalid: '请用宽x高填写支持的尺寸，或填写 auto',
  imageCapabilitiesInvalid: '请为每组能力选择至少一个支持的选项', imageReferenceInvalid: '参考图片上限必须是正整数',
  imageTransparencyInvalid: '透明背景需要 PNG 或 WebP 格式', imageReset: '恢复继承的图片模型',
}
