import type {
  NewspaperItem,
  NewspaperItemKind,
  NewspaperSection,
  NewspaperSectionKey,
} from '../../db/schema.js'

export type { NewspaperItem, NewspaperItemKind, NewspaperSection, NewspaperSectionKey }

export const SECTION_KEYS: NewspaperSectionKey[] = [
  'hangzhou',
  'benxi',
  'bili',
  'steam',
  'china',
  'world',
]

export type SectionMeta = {
  key: NewspaperSectionKey
  title: string
  subtitle: string
  /** 告诉 AI 这一版选什么、怎么写 */
  focus: string
  minItems: number
  maxItems: number
}

export const SECTION_META: Record<NewspaperSectionKey, SectionMeta> = {
  hangzhou: {
    key: 'hangzhou',
    title: '杭州大事',
    subtitle: '本地突发、民生、城建与民间热议',
    focus:
      '优先选具体的杭州本地事件：突发事故、天气影响、交通与城建、政策变化、消费维权、小区/物业矛盾、本地热议。少用会议、视察、宣传稿。民间讨论和官方通报都要，但事实以官方/正规媒体为准。',
    minItems: 2,
    maxItems: 6,
  },
  benxi: {
    key: 'benxi',
    title: '辽宁本溪',
    subtitle: '本溪及辽宁东部的大小事',
    focus:
      '优先选本溪本地事件：民生、突发、政务、城建、消费维权、本地人讨论。素材少时宁可少写，不要拿沈阳、大连或全国新闻凑数；确实没有本地新闻时，可以在 note 里说明。',
    minItems: 2,
    maxItems: 5,
  },
  bili: {
    key: 'bili',
    title: 'B站吃瓜',
    subtitle: 'UP主争议、粉丝吵架与社区热议',
    focus:
      '重点找过去 24-72 小时 B 站的争议、塌房、粉丝互撕、控评、拉踩、翻车、道歉、辟谣、UP主回应。写清谁、什么事、目前进展、粉丝/路人怎么说。未经证实必须写“网传/暂未回应”，不要下定性结论，不要编造当事人表态。没有真瓜就如实说今天比较平静，用热门内容代替。',
    minItems: 2,
    maxItems: 5,
  },
  steam: {
    key: 'steam',
    title: 'Steam 游戏',
    subtitle: '新游、热销、折扣、更新与争议',
    focus:
      '选 Steam 玩家真正关心的：新游爆款/翻车、热销榜变化、折扣、重大更新、差评争议、涨价降价、平台政策、赛事。优先有具体游戏名和数据的信息，不要写空泛的行业评论；素材里有 Steam 官方更新/公告时，至少留一条。',
    minItems: 2,
    maxItems: 5,
  },
  china: {
    key: 'china',
    title: '中国大事',
    subtitle: '时政、经济、社会与民间热点',
    focus:
      '选全国性大事：时政、经济、社会、科技、公共安全。官方发布之外，优先选百度/微博/知乎/抖音/贴吧正在热议、且与普通人生活相关的条目；民间讨论与官方通报并重，避免整版宣传稿。',
    minItems: 4,
    maxItems: 6,
  },
  world: {
    key: 'world',
    title: '世界新闻',
    subtitle: '国际大事与对中国的影响',
    focus:
      '选真正有影响力的国际事件：战争冲突、外交、选举、经济金融、科技、灾难。优先选与中国或普通人生活有关联的角度；不要选猎奇小新闻，也不要选中国国内赛事/文化活动（除非涉及重大国际关系）。英文标题和摘要请翻译成简体中文，保留原意。',
    minItems: 3,
    maxItems: 6,
  },
}

/** 采集阶段的通用条目；AI 只能引用这些条目，不能自己造链接 */
export type RawItem = {
  title: string
  summary: string
  source: string
  url: string | null
  /** ISO 时间，无法解析时为 null */
  publishedAt: string | null
  /** 来源页面上显示的原始时间文案，如「13小时前」 */
  publishedLabel: string | null
  /** 榜单/热度文案，如「微博热搜第 3」 */
  heat: string | null
  kind: NewspaperItemKind
  tags: string[]
}

export type RawMaterial = {
  bySection: Record<NewspaperSectionKey, RawItem[]>
  stats: Record<string, number>
  errors: { source: string; message: string }[]
  collectedAt: string
}

export type ComposedSection = {
  section: NewspaperSection
  usedRaw: number
}
