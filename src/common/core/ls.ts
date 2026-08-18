import cheerio from 'cheerio'
import type {Cheerio} from 'cheerio'
import {byteToSize, delay, sizeToByte} from '../util'
import {Matcher} from './matcher'
import * as http from '../http'
import {config} from '../../renderer/store/Config'

export enum URLType {
  file = 'file', // https://wws.lanzous.com/ivvHsi3qyef
  folder = 'folder', // https://wws.lanzous.com/b01tp3zkj
}

/**
 * 列出文件夹下的所有文件 + 目录
 * cookie
 * @example
 * ls // folder_id
 * ls https://xxxx/xxxx --pwd 123 // url, pwd
 */
export interface LsFiles {
  name: string
  type: URLType
  id: string // 文件id 或者 文件夹id

  icon?: string // 从 source 里面拿
  size?: string
  time?: string
  downs?: string
  source: FileInfo | FolderInfo
}

export interface LsResult {
  info: CrumbsInfo[]
  text: LsFiles[]
}

// ==================== PoW 算解 & Cookie 缓存逻辑 ====================

let cachedAcwCookie = ''
let acwCookieExpiresAt = 0

/**
 * 根据 arg1 计算 acw_sc__v2 Cookie
 */
export function calcAcwScV2(arg1: string): string {
  const mask = [
    15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23, 25, 13, 6,
    11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17, 5, 3, 28, 34, 37, 12, 36,
  ]
  // 更新为最新的正确 Key 常量
  const key = '3000176000856006061501533003690027800375'

  const reordered: string[] = []
  for (let i = 0; i < mask.length; i++) {
    reordered[i] = arg1[mask[i] - 1]
  }
  const u = reordered.join('')

  let acwScV2 = ''
  for (let i = 0; i < u.length && i < key.length; i += 2) {
    const num1 = parseInt(u.substring(i, i + 2), 16)
    const num2 = parseInt(key.substring(i, i + 2), 16)
    let xorHex = (num1 ^ num2).toString(16)
    if (xorHex.length === 1) {
      xorHex = '0' + xorHex
    }
    acwScV2 += xorHex
  }

  return acwScV2
}

/**
 * 更新全局缓存 Cookie
 */
function updateAcwCookie(arg1: string) {
  cachedAcwCookie = calcAcwScV2(arg1)
  // Cookie 有效期设定为 55 分钟 (稍微小于 1 小时)
  acwCookieExpiresAt = Date.now() + 55 * 60 * 1000
}

/**
 * 获取附带 acw_sc__v2 的 Headers 字典
 */
function getAcwHeaders(headers: Record<string, string> = {}): Record<string, string> {
  if (!cachedAcwCookie || Date.now() >= acwCookieExpiresAt) {
    return { ...headers }
  }

  const cookieKey = Object.keys(headers).find(k => k.toLowerCase() === 'cookie') || 'cookie'
  const existingCookie = headers[cookieKey]
  const acwCookieStr = `acw_sc__v2=${cachedAcwCookie}`

  return {
    ...headers,
    [cookieKey]: existingCookie ? `${existingCookie}; ${acwCookieStr}` : acwCookieStr,
  }
}

/**
 * 带 PoW 验证防线的页面 GET 请求封装 (最多重试 3 次)
 */
async function fetchSharePage(url: string, maxRetries = 3): Promise<{ html: string; finalUrl: string }> {
  let retries = 0
  let currentUrl = url

  while (retries <= maxRetries) {
    const instance = http.share.get(currentUrl, {
      headers: getAcwHeaders(),
    })
    const response = await instance
    currentUrl = response.url
    const html = await instance.text()

    const arg1Match = html.match(/var\s+arg1\s*=\s*['"]([^'"]+)['"]/)
    if (arg1Match && arg1Match[1]) {
      if (retries >= maxRetries) {
        throw new Error('破墙失败：超出最大重试次数，仍返回 PoW 验证')
      }
      console.log("检测到 PoW 墙，正在尝试正经的计算以通过：", arg1Match[1])
      updateAcwCookie(arg1Match[1])
      retries++
      await delay(300)
      continue
    }

    return { html, finalUrl: currentUrl }
  }

  throw new Error('破墙失败：无法获取有效页面')
}

/**
 * 带 PoW 验证防线的 JSON API 请求封装 (最多重试 3 次)
 */
async function requestJsonWithPow<T>(
  makeRequest: (headers: Record<string, string>) => any,
  maxRetries = 3
): Promise<T> {
  let retries = 0

  while (retries <= maxRetries) {
    const headers = getAcwHeaders()
    const req = makeRequest(headers)
    const rawText = await req.text()

    const arg1Match = rawText.match(/var\s+arg1\s*=\s*['"]([^'"]+)['"]/)
    if (arg1Match && arg1Match[1]) {
      if (retries >= maxRetries) {
        throw new Error('破墙失败：超出最大重试次数，仍返回 PoW 验证')
      }
      updateAcwCookie(arg1Match[1])
      retries++
      await delay(300)
      continue
    }

    return JSON.parse(rawText) as T
  }

  throw new Error('破墙失败')
}

// ==================== 业务接口实现 ====================

/**
 * 文件列表
 * @param folder_id
 * @param folderFirst 文件夹优先 true
 */
export async function ls(folder_id: FolderId = -1, folderFirst = true): Promise<LsResult> {
  const [res1, res2] = await Promise.all([lsDir(folder_id), lsFile(folder_id)])

  const folders =
    res1.text?.map(value => ({
      name: value.name,
      type: URLType.folder,
      id: `${value.fol_id}`,
      source: value,
    })) || []
  const files = res2.map(value => ({
    name: value.name_all,
    type: URLType.file,
    id: `${value.id}`,
    icon: value.icon,
    size: value.size,
    time: value.time,
    downs: value.downs,
    source: value,
  }))

  return {
    info: res1.info,
    text: folderFirst ? [...folders, ...files] : [...files, ...folders],
  }
}

/**
 * 列出文件夹下所有文件
 * cookie
 */
export async function lsFile(folder_id: FolderId) {
  let pg = 1
  let next = true
  const fileList: Task5Res['text'] = []
  do {
    const {text} = await requestJsonWithPow<Task5Res>(headers =>
      http.request.post(config.more.url?.replace(/^\//, ''), {
        headers,
        form: {task: 5, folder_id, pg: pg++, vei: config.more.data?.vei} as Task5,
      })
    )
    // todo: 蓝奏分页数量：api：18，分享页：50
    next = Array.isArray(text) && text.length >= 18
    if (Array.isArray(text)) {
      fileList.push(...text)
    }
  } while (next)

  return fileList
}

/**
 * 列出该文件夹下的所有文件夹
 * cookie
 */
export async function lsDir(folder_id: FolderId) {
  return requestJsonWithPow<Task47Res>(headers =>
    http.request.post('doupload.php', {
      headers,
      form: {task: 47, folder_id} as Task47,
    })
  )
}

export interface LsShareObject {
  name: string
  size: string
  type: URLType
  list: LsShareItem[]
}

export interface LsShareItem {
  url: string // 如果文件有密码，则带有 webpage 参数
  name: string
  size: string
  time: string
  pwd?: string
}

/**
 * 文件：
 * * 无密码: iframe
 * * 密码: #passwddiv
 * 文件夹：同一种处理方式
 * * 无密码: #filemore; title
 * * 密码: #pwdload
 */
export async function lsShare({url, pwd}: {url: string; pwd?: string}): Promise<LsShareObject> {
  const pageRes = await fetchSharePage(url)
  url = pageRes.finalUrl
  const html = pageRes.html

  const $ = cheerio.load(html)

  // 根据html区分哪种解析类型
  const isFile = !!$('iframe').length
  const isPwdFile = !!$('#passwddiv').length
  const isPwdFolder = !!$('#pwdload').length
  const isFolder = !!$('#filemore').length && !isPwdFolder // 密码和无密码页面

  console.log("加载链接：", url, "\n文件：", isFile, "\n密码文件：", isPwdFile, "\n文件夹：", isFolder, "\n密码文件夹：", isPwdFolder, "\n链接返回：", html)

  if ((isPwdFile || isPwdFolder) && !pwd) {
    throw new Error('密码不能为空')
  }

  const title = $('title').text()
  if (isFile) {
    const name = title.replace(' - 蓝奏云', '') // '(文件名) - 蓝奏云',
    const size = $('meta[name=description]').attr('content').split('|')[0].replace('文件大小：', '')

    let time = html.match(/上传时间：<\/span>(.*?)<br>/)?.[1]
    if (!time) {
      // https://xiaodao.lanzoui.com/iejwp06dnwyj
      let fileInfos: Cheerio<any> = null
      if ((fileInfos = $('.n_file_info > .n_file_infos')) && fileInfos.length > 1) {
        time = fileInfos.first().text()
      }
    }
    if (!time) {
      // https://dkbd.lanzoui.com/dkbdv7
      const src = $('.filename img').attr('src')
      if (src) {
        time = new URL(src).pathname
          .split('/')
          .filter(value => /^\d+$/.test(value))
          .join('-')
      }
    }
    return {name, size, type: URLType.file, list: [{url, name, size, time}]}
  } else if (isPwdFile) {
    const ajaxData = await Matcher.parsePwdAjax(html, pwd)

    const {inf} = await requestJsonWithPow<DownloadUrlRes>(headers =>
      http.share(new URL(ajaxData.url, url), {
        method: ajaxData.type,
        headers: {...headers, referer: url},
        form: ajaxData.data,
        context: {hideMessage: true},
      })
    )

    const name = inf // 文件名
    const size = $('meta[name=description]').attr('content').split('|')[0].replace('文件大小：', '')
    const time = $('.n_file_info > .n_file_infos:first-child').text()
    return {name, size, type: URLType.file, list: [{url, pwd, name, size, time}]}
  } else if (isFolder || isPwdFolder) {
    const value = await _lsShareFolder({pwd, url, html})
    return {
      name: title, // (文件夹名)
      type: URLType.folder,
      size: byteToSize(value.list?.reduce((total, item) => total + sizeToByte(item.size), 0)),
      list: value.list?.map(item => ({
        url: new URL(item.id, url).toString(),
        name: item.name_all,
        size: item.size,
        time: item.time,
      })),
    }
  } else {
    // 解析错误: https://hzgzs.lanzoui.com/s/iv1hxrmbpgb
    const errorMsg = $('.off').text() || `解析错误：${url}`
    throw new Error(errorMsg)
  }
}

/**
 * 解析分享文件夹
 * 发送 ajax，如有密码，则带上 pwd
 * @param options
 */
async function _lsShareFolder({url, pwd, html}: {url: string; pwd?: string; html?: string}) {
  if (!html) {
    const pageRes = await fetchSharePage(url)
    url = pageRes.finalUrl
    html = pageRes.html
  }

  const $ = cheerio.load(html)
  const title = $('title').text()

  const ajaxData = await Matcher.parseFolderAjax(html)

  let pg = 1
  const shareFiles: ShareFile[] = []

  while (true) {
    const {text} = await requestJsonWithPow<ShareFileRes>(headers =>
      http.share(new URL(ajaxData.url, url), {
        method: ajaxData.type,
        headers: {...headers, referer: url},
        form: {...ajaxData.data, pg: pg++, pwd},
        context: {hideMessage: true},
      })
    )

    if (Array.isArray(text)) {
      shareFiles.push(...text)
    }

    if (Array.isArray(text) && text.length >= 50) {
      await delay(2000)
    } else {
      break
    }
  }

  return {name: title, list: shareFiles}
}
