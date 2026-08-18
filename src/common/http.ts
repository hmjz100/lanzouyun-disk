import got from 'got'
import {message} from 'antd'
import is from 'electron-is'

import {cookieJar, shareCookieJar} from './cookie'
import {delay} from './util'
import {config} from '../renderer/store/Config'
import {logout} from '../renderer/utils/app'

/**
 * 根据 arg1 计算 acw_sc__v2 Cookie 值的算法
 */
export function calcAcwScV2(arg1: string): string {
    const MASK: number[] = [15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25, 13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17, 5, 3, 28, 34, 37, 12, 36];
    const XOR_KEY: string = "3000176000856006061501533003690027800375";

    const reorderedChars: string[] = new Array(MASK.length);
    for (let i = 0; i < MASK.length; i++) {
        reorderedChars[i] = arg1[MASK[i] - 1];
    }
    const reorderedHex: string = reorderedChars.join("");

    let acwScV2: string = "";
    const step: number = 2;
    for (let i = 0; i < reorderedHex.length && i < XOR_KEY.length; i += step) {
        const byteA: number = parseInt(reorderedHex.slice(i, i + step), 16);
        const byteB: number = parseInt(XOR_KEY.slice(i, i + step), 16);
        const xorResult: string = (byteA ^ byteB).toString(16).padStart(2, "0");
        acwScV2 += xorResult;
    }
    return acwScV2;
}

/**
 * 辅助函数：在现有 Cookie 字符串中替换或追加 acw_sc__v2
 */
function appendAcwCookie(existingCookie: string = '', acwValue: string): string {
  const acwStr = `acw_sc__v2=${acwValue}`
  if (!existingCookie) return acwStr
  if (existingCookie.includes('acw_sc__v2=')) {
    return existingCookie.replace(/acw_sc__v2=[^;]+/, acwStr)
  }
  return `${existingCookie}; ${acwStr}`
}

const base = got.extend({
  headers: {
    'accept-language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8',
    pragma: 'no-cache',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  },
  hooks: {
    init: [
      (_, self) => {
        self.headers['user-agent'] = config.userAgent
      },
    ],
    afterResponse: [
      async (response, retryWithMergedOptions) => {
        const bodyStr = typeof response.body === 'string'
          ? response.body
          : (response.body ? String(response.body) : '')

        // 1. 优先检测响应中是否包含 PoW 验证墙 (arg1)
        const arg1Match = bodyStr.match(/var\s+arg1\s*=\s*['"]([^'"]+)['"]/)
        if (arg1Match && arg1Match[1]) {
          const retries = ((response.request.options.context?.powRetryCount as number) || 0) + 1
          if (retries > 3) {
            throw new Error('破墙失败：超出最大重试次数')
          }
          console.log('检测到 PoW 墙，尝试计算通过：', arg1Match[1])

          const acwCookieValue = calcAcwScV2(arg1Match[1])
          const targetUrl = response.request.options.url.toString()
          const currentCookieJar = response.request.options.cookieJar

          // 写入关联的 CookieJar 中，以便后续其他请求也能共享此 Cookie
          if (currentCookieJar) {
            const cookieStr = `acw_sc__v2=${acwCookieValue}; Path=/; Domain=${new URL(targetUrl).hostname}`
            if (typeof (currentCookieJar as any).setCookie === 'function') {
              await new Promise(resolve => {
                (currentCookieJar as any).setCookie(cookieStr, targetUrl, () => resolve(true))
              }).catch(() => {})
            } else if (typeof (currentCookieJar as any).setCookieSync === 'function') {
              try {
                (currentCookieJar as any).setCookieSync(cookieStr, targetUrl)
              } catch (e) {}
            }
          }

          await delay(300)

          // 构造新的 Cookie Header 强制带上计算好的 acw_sc__v2 重新请求
          const existingHeaders = response.request.options.headers || {}
          const currentCookieHeader = (existingHeaders['cookie'] || existingHeaders['Cookie'] || '') as string
          const newCookieHeader = appendAcwCookie(currentCookieHeader, acwCookieValue)

          return retryWithMergedOptions({
            context: {
              ...response.request.options.context,
              powRetryCount: retries,
            },
            headers: {
              cookie: newCookieHeader,
            },
          })
        }

        // 2. 返回值状态判断。蓝奏云返回类型: text/json，github 返回类型: application/json
        if (response.headers['content-type']?.includes('text/json')) {
          const body = JSON.parse(response.body as string)
          switch (body.zt) {
            // 1,2 成功
            case 1:
            case 2:
              return response
            case 9:
              message.error('登录信息失效，请重新登录')
              await delay()
              await logout()
              return response
            default:
              throw new Error(typeof body.info === 'string' ? body.info : body.text)
          }
        }
        return response
      },
    ],
    beforeError: [
      error => {
        console.log('error, url:', error.options.url.toString())
        console.error(error)
        if (!error.options?.context?.hideMessage) {
          message.error(error.message)
        }
        return error
      },
    ],
  },
  https: {rejectUnauthorized: false},
  ...(is.dev() ? {} : {}),
})

export const request = got.extend(base, {
  cookieJar,
  hooks: {
    init: [
      (_, self) => {
        if (!self.prefixUrl) {
          self.prefixUrl = config.lanzouUrl
        }
      },
    ],
    beforeRequest: [
      options => {
        if (config.referer && (!options.headers['referer'] || !options.headers['Referer'])) {
          const url = typeof options.url === 'string' ? new URL(options.url) : options.url
          if (url.origin === new URL(config.referer).origin) {
            options.headers['referer'] = config.referer
          }
        }
      },
    ],
  },
})

export const share = got.extend(base, {
  cookieJar: shareCookieJar,
  ignoreInvalidCookies: true,
})
