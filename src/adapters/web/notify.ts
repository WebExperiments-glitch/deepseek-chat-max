/**
 * Web 端通知适配器：把核心层的 NotifyPort 桥接到 UI 的 toastState。
 * 这是唯一 import 组件层 toastState 的地方——核心层通过端口拿 notify，不再反向依赖 UI。
 */
import { showToast } from '../../components/base/toastState.js'
import type { NotifyPort } from '../../ports/index.js'
import type { TranslationKey } from '../../i18n/index.js'

export const webNotify: NotifyPort = (message) => {
  showToast({ key: message.key as TranslationKey, params: message.params })
}
