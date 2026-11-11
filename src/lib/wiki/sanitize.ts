import { load } from 'cheerio'
import { isSameSite, resolveHref } from './url.js'

/** 直接删除、连内容都不要的标签 */
const DROP_TAGS = [
  'script',
  'style',
  'link',
  'meta',
  'noscript',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'select',
  'button',
  'textarea',
  'audio',
  'video',
  'canvas',
  'map',
  'area',
  'svg',
]

/** 导航、侧栏、维护模板等非正文区块 */
const DROP_SELECTORS = [
  '#mw-navigation',
  '#footer',
  '#catlinks',
  '.mw-editsection',
  '.mw-jump-link',
  '.mw-indicators',
  '.printfooter',
  '.noprint',
  '.navbox',
  '.navbox-styles',
  '.navbox-container',
  '.ranger-navbox',
  '.vertical-navbox',
  '.sistersitebox',
  '.ambox',
  '.mbox',
  '.ombox',
  '.tmbox',
  '.cmbox',
  '.fmbox',
  '.mw-collapsible-toggle',
  '.mw-collapsible-toggle-placeholder',
  '.mw-empty-elt',
]

/** 允许保留的标签（其余一律解包，保留文字） */
const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center',
  'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl',
  'dt', 'em', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins',
  'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'wbr',
])

/** MathML 公式标签 */
const MATH_TAGS = new Set([
  'math', 'annotation', 'annotation-xml', 'maction', 'menclose', 'merror',
  'mfenced', 'mfrac', 'mi', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded',
  'mphantom', 'mprescripts', 'mroot', 'mrow', 'ms', 'mspace', 'msqrt', 'mstyle',
  'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder',
  'munderover',
])

const GLOBAL_ATTRS = new Set(['id', 'class', 'title', 'lang', 'dir'])
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  td: new Set(['colspan', 'rowspan', 'headers', 'scope', 'align', 'valign']),
  th: new Set(['colspan', 'rowspan', 'headers', 'scope', 'align', 'valign', 'abbr']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'type', 'reversed']),
  li: new Set(['value']),
  math: new Set(['display']),
}

const IMAGE_PLACEHOLDER = '[图片]'
const SMALL_ICON_MAX_WIDTH = 24

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function squeeze(input: string): string {
  return input.replace(/[\s\u00a0\u3000]+/g, ' ').trim()
}

function isMediaFileLink(pathname: string): boolean {
  return /\/wiki\/(File|Image|文件|图像|檔案|档案):/i.test(pathname)
}

/** alt 是图片文件名（如 Stack digit 9.png）时没有保留价值 */
function isFilenameAlt(alt: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i.test(alt)
}

export type SanitizeOptions = {
  /** 当前页面地址，用于解析相对链接 */
  pageUrl: URL
  /** 正文最大字符数，防止异常巨大的页面拖垮渲染 */
  maxTextLength?: number
}

export type SanitizeStats = {
  images: number
  links: number
  externalLinks: number
  textLength: number
}

export type SanitizeResult = {
  html: string
  stats: SanitizeStats
}

/**
 * 把第三方 wiki 的正文 HTML 清洗成只含安全标签的片段：
 * 去图片、去导航、去配色，站内链接改写成 /wiki?u=...
 */
export function sanitizeWikiHtml(rawHtml: string, options: SanitizeOptions): SanitizeResult {
  const $ = load(rawHtml, null, false)
  const pageUrl = options.pageUrl
  const maxTextLength = options.maxTextLength ?? 400_000

  let imageCount = 0
  let externalLinks = 0

  $(DROP_TAGS.join(',')).remove()
  $(DROP_SELECTORS.join(',')).remove()

  // 缩略图：整块换成一行图注，避免留下空边框
  $('div.thumb, div.tmulti, figure').each((_, element) => {
    const $block = $(element)
    const caption = squeeze(
      $block.find('.thumbcaption, figcaption').first().text() || $block.attr('title') || '',
    )
    imageCount += 1
    $block.replaceWith(
      `<div class="wv-fig"><span class="wv-fig-mark">${IMAGE_PLACEHOLDER}</span>${
        caption ? ` <span class="wv-fig-cap">${escapeHtml(caption)}</span>` : ''
      }</div>`,
    )
  })

  // 剩余图片：按“是否链接装饰、尺寸、alt”决定怎么占位
  $('img').each((_, element) => {
    const $img = $(element)
    const alt = squeeze($img.attr('alt') ?? '')
    const width = Number.parseInt($img.attr('width') ?? '', 10) || 0
    const meaningfulAlt = Boolean(alt) && !isFilenameAlt(alt)

    imageCount += 1

    const $link = $img.closest('a')

    // 链接内的图标：同一容器里还有其他“带文字的链接”时，图标只是重复的视觉标记
    if ($link.length) {
      const hasTextSibling = $link
        .parent()
        .find('a')
        .toArray()
        .some((sibling) => {
          if (sibling === $link[0]) return false
          const $sibling = $(sibling)
          // 已经替换成占位符的图标不算“文字”
          const text = squeeze(
            $sibling.clone().find('.wv-ico, .wv-img').remove().end().text(),
          )
          return text !== ''
        })

      if (hasTextSibling || !meaningfulAlt) {
        $img.remove()
        return
      }
      $img.replaceWith(`<span class="wv-ico">${escapeHtml(alt)}</span>`)
      return
    }

    if (width > 0 && width <= SMALL_ICON_MAX_WIDTH) {
      if (meaningfulAlt) $img.replaceWith(`<span class="wv-ico">${escapeHtml(alt)}</span>`)
      else $img.remove()
      return
    }

    $img.replaceWith(
      `<span class="wv-img">${IMAGE_PLACEHOLDER}${
        meaningfulAlt ? `：${escapeHtml(alt)}` : ''
      }</span>`,
    )
  })

  // 标签与属性白名单
  $('*').each((_, element) => {
    const node = element as unknown as {
      tagName?: string
      attribs?: Record<string, string>
      children?: unknown[]
    }
    const tag = (node.tagName ?? '').toLowerCase()
    if (!tag) return

    const allowed = ALLOWED_TAGS.has(tag) || MATH_TAGS.has(tag)

    if (!allowed) {
      // 解包：保留文字和子元素，丢掉标签本身
      const $node = $(element)
      $node.replaceWith($node.contents())
      return
    }

    const attribs = node.attribs ?? {}
    for (const name of Object.keys(attribs)) {
      const lower = name.toLowerCase()
      const tagAttrs = TAG_ATTRS[tag]
      const keep = GLOBAL_ATTRS.has(lower) || Boolean(tagAttrs?.has(lower))
      if (!keep || lower.startsWith('on')) {
        $(element).removeAttr(name)
      }
    }
  })

  // 链接：站内改写，站外保留，媒体文件页降级成文字
  $('a').each((_, element) => {
    const $a = $(element)

    if ($a.hasClass('mw-selflink')) {
      $a.removeAttr('href')
      $a.addClass('wv-self')
      return
    }

    const href = ($a.attr('href') ?? '').trim()
    if (!href) {
      $a.addClass('wv-plain')
      return
    }

    if (href.startsWith('#')) {
      $a.addClass('wv-anchor')
      return
    }

    const absolute = resolveHref(href, pageUrl)
    if (!absolute) {
      // javascript: / data: / 无法解析 —— 解包成纯文字
      $a.replaceWith($a.contents())
      return
    }

    if (isMediaFileLink(absolute.pathname)) {
      $a.replaceWith($a.contents())
      return
    }

    if (isSameSite(absolute, pageUrl)) {
      absolute.hash = absolute.hash || ''
      $a.attr('href', `/wiki?u=${encodeURIComponent(absolute.href)}`)
      $a.attr('class', `${$a.attr('class') ?? ''} wv-link`.trim())
      $a.removeAttr('target')
      $a.removeAttr('rel')
      return
    }

    externalLinks += 1
    $a.attr('href', absolute.href)
    $a.attr('target', '_blank')
    $a.attr('rel', 'noopener noreferrer')
    $a.attr('class', `${$a.attr('class') ?? ''} wv-ext`.trim())
  })

  // 表格与代码块加统一 class，前端只按这些 class 出样式
  $('table').each((_, element) => {
    const $table = $(element)
    $table.attr('class', `${$table.attr('class') ?? ''} wv-table`.trim())
  })
  $('pre').each((_, element) => {
    const $pre = $(element)
    $pre.attr('class', `${$pre.attr('class') ?? ''} wv-pre`.trim())
  })

  // 去掉完全空掉的块级元素，避免大面积空白
  $('p, div, span, li, td, th').each((_, element) => {
    const $node = $(element)
    if ($node.children().length) return
    if (squeeze($node.text())) return
    $node.remove()
  })

  const html = $.root().html() ?? ''
  const textLength = squeeze($.root().text()).length

  if (textLength > maxTextLength) {
    throw new Error(`正文过长（${textLength} 字符），已停止渲染`)
  }

  return {
    html,
    stats: {
      images: imageCount,
      links: $('a').length,
      externalLinks,
      textLength,
    },
  }
}

/** 给前端做测试用的导出 */
export const sanitizeInternals = {
  DROP_SELECTORS,
  IMAGE_PLACEHOLDER,
}
