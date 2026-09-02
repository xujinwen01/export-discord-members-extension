// ============================================================
// PaymentClient —— 付费验证 SDK 的「类型化桩」(stub)
//
// 完整实现见参考项目反混淆产物：
//   /Users/qinwenxu/Documents/private/dme-deobfuscated/content-scripts/payment-success.js
//   （约 1300 行：登录 / 付费校验 / 配置解密 / 阿里云日志上报）
//
// 这里只实现 background 用到的接口，返回「免费模式」的默认值，
// 让核心导出流程可以先跑通；接入真实 SDK 时替换本文件即可。
// ============================================================

export interface PaymentConfig {
  isPaid?: boolean;
  features?: { freeMemberLimit?: number };
  reviewEnabled?: boolean;
  [key: string]: unknown;
}

export interface PaymentUserInfo {
  isPaid?: boolean;
  email?: string;
  [key: string]: unknown;
}

export interface PaymentClientOptions {
  productId: string;
  apiEndpoint?: string;
  encryptionSecret?: string;
  pluginId?: string;
  version?: string;
  enableAliLog?: boolean;
  [key: string]: unknown;
}

export class PaymentClient {
  readonly productId: string;
  readonly apiEndpoint: string;
  readonly enableAliLog: boolean;

  constructor(cfg: PaymentClientOptions) {
    this.productId = cfg.productId;
    this.apiEndpoint = cfg.apiEndpoint ?? "";
    this.enableAliLog = cfg.enableAliLog === true;
  }

  startBackground(): this {
    return this;
  }

  /** 拉取产品配置。桩实现：始终返回免费配置。 */
  async getConfig(): Promise<PaymentConfig> {
    return { isPaid: false, features: { freeMemberLimit: 100 }, reviewEnabled: true };
  }

  async isLoggedIn(): Promise<boolean> {
    return false;
  }

  async fetchUserInfo(): Promise<PaymentUserInfo | null> {
    return null;
  }

  async isPaid(): Promise<boolean> {
    return false;
  }

  /** 阿里云日志上报。桩实现：直接忽略。 */
  async sendAli(_category: string, _operate = "", _data?: Record<string, unknown>): Promise<void> {
    // no-op
  }
}
