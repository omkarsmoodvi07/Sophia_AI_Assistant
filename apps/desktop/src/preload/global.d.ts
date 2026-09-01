import type { ElectronAPI } from '@electron-toolkit/preload'
import type { SophiaApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    api: SophiaApi
  }
}

export {}
