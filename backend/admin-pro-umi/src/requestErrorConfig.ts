import type { RequestConfig } from '@umijs/max';
import { message, notification } from 'antd';

enum ErrorShowType {
  SILENT = 0,
  WARN_MESSAGE = 1,
  ERROR_MESSAGE = 2,
  NOTIFICATION = 3,
  REDIRECT = 9,
}

interface ResponseStructure {
  success: boolean;
  data: unknown;
  errorCode?: number;
  errorMessage?: string;
  showType?: ErrorShowType;
  message?: string;
}

export const errorConfig: RequestConfig = {
  errorConfig: {
    errorThrower: (res) => {
      const payload = res as unknown as ResponseStructure;
      const backendMessage = payload.errorMessage || payload.message;
      if (!payload.success) {
        const error: Error & {
          name?: string;
          info?: {
            errorCode?: number;
            errorMessage?: string;
            showType?: ErrorShowType;
          };
        } = new Error(backendMessage || 'Request failed');
        error.name = 'BizError';
        error.info = {
          errorCode: payload.errorCode,
          errorMessage: backendMessage,
          showType: payload.showType,
        };
        throw error;
      }
    },
    errorHandler: (error: unknown, opts: { skipErrorHandler?: boolean } | undefined) => {
      if (opts?.skipErrorHandler) {
        throw error;
      }
      const safeError = error as {
        name?: string;
        info?: {
          errorCode?: number;
          errorMessage?: string;
          showType?: ErrorShowType;
        };
        response?: { status?: number };
        request?: unknown;
      };
      if (safeError.name === 'BizError') {
        const errorInfo = safeError.info;
        const messageText = errorInfo?.errorMessage || 'Request failed';
        switch (errorInfo?.showType) {
          case ErrorShowType.SILENT:
            break;
          case ErrorShowType.WARN_MESSAGE:
            message.warning(messageText);
            break;
          case ErrorShowType.ERROR_MESSAGE:
            message.error(messageText);
            break;
          case ErrorShowType.NOTIFICATION:
            notification.open({
              message: String(errorInfo?.errorCode || 'Error'),
              description: messageText,
            });
            break;
          case ErrorShowType.REDIRECT:
            message.error(messageText);
            break;
          default:
            message.error(messageText);
        }
        return;
      }
      if (safeError.response) {
        message.error(`Request failed with status ${safeError.response.status || 500}`);
        return;
      }
      if (safeError.request) {
        message.error('No response from server. Please retry.');
        return;
      }
      message.error('Request error, please retry.');
    },
  },
};
