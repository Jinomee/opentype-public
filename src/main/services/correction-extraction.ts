export interface CorrectionPair { original: string; replacement: string }
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
const ignored = new Set(['今天', '明天', '后天', '昨天', '上午', '下午', '晚上', '是', '不是', '可以', '不可以', '同意', '不同意'])
function term(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}
export function isCorrectionTerm(value: string) {
  return value.length >= 2 && value.length <= 24 && !ignored.has(value)
    && /^[\p{L}][\p{L} +#-]*[\p{L}+#]$/u.test(value)
    && !/^[零〇一二三四五六七八九十百千万亿两]+(?:点|年|月|日|时|分|秒|折|元|个)?$/.test(value)
    && value.split(' ').length <= 3
}
function technicalAt(text: string, at: number) {
  const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, text.indexOf('\n', at) < 0 ? undefined : text.indexOf('\n', at))
  return /[`{}<>@=]|:\/\/|(?:^|\s)(?:[~/]|[a-z]:\\)|^\s*(?:const|let|var|import|export|return|def|class|function|SELECT|curl|npm|git)\s/i.test(line)
    || ([...text.slice(0, at).matchAll(/^\s*(?:`{3,}|~{3,})/gm)].length % 2 === 1)
}

/** Local proposals, never automatic replacements. Word boundaries prevent partial
 * English names; bounded LCS skips broad rewrites instead of guessing a dictionary. */
export function extractCorrections(before: string, after: string): CorrectionPair[] {
  if (before === after || !before || !after || before.length > 100_000 || after.length > 100_000) return []
  const left = [...segmenter.segment(before)].map(s => s.segment)
  const right = [...segmenter.segment(after)].map(s => s.segment)
  const positions = (tokens: string[]) => { let at = 0; return tokens.map(s => { const start = at; at += s.length; return start }) }
  const leftAt = positions(left), rightAt = positions(right)
  let prefix = 0, aEnd = left.length, bEnd = right.length
  while (prefix < aEnd && prefix < bEnd && left[prefix] === right[prefix]) prefix++
  while (aEnd > prefix && bEnd > prefix && left[aEnd - 1] === right[bEnd - 1]) { aEnd--; bEnd-- }
  const a = left.slice(prefix, aEnd), b = right.slice(prefix, bEnd)
  if (!a.length || !b.length || a.length * b.length > 40_000 || Math.max(a.length, b.length) > 500) return []
  const width = b.length + 1, matrix = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    matrix[i * width + j] = a[i] === b[j] ? 1 + matrix[(i + 1) * width + j + 1]
      : Math.max(matrix[(i + 1) * width + j], matrix[i * width + j + 1])
  }
  const result: CorrectionPair[] = [], seen = new Set<string>()
  let i = 0, j = 0, oldStart = 0, nextStart = 0, old: string[] = [], next: string[] = []
  const flush = () => {
    let original = term(old.join('')), replacement = term(next.join(''))
    let originalAt = leftAt[prefix + oldStart], replacementAt = rightAt[prefix + nextStart]
    // Chinese segmentation can split an unfamiliar name into single Han
    // characters. For a one-character substitution, include one unchanged
    // adjacent Han character so the proposal remains a usable complete token
    // (e.g. 张伟 → 张维), without expanding across punctuation or spaces.
    if (old.length === 1 && next.length === 1 && /^\p{Script=Han}$/u.test(old[0]) && /^\p{Script=Han}$/u.test(next[0])) {
      const leftIndex = prefix + oldStart - 1, rightIndex = prefix + nextStart - 1
      const canExpandLeft = leftIndex >= 0 && rightIndex >= 0 && left[leftIndex] === right[rightIndex]
        && /^\p{Script=Han}$/u.test(left[leftIndex])
      if (canExpandLeft) {
        original = left[leftIndex] + original; replacement = right[rightIndex] + replacement
        originalAt = leftAt[leftIndex]; replacementAt = rightAt[rightIndex]
      } else {
        const oldNext = prefix + oldStart + 1, newNext = prefix + nextStart + 1
        if (oldNext < left.length && newNext < right.length && left[oldNext] === right[newNext]
          && /^\p{Script=Han}$/u.test(left[oldNext])) {
          original += left[oldNext]; replacement += right[newNext]
        }
      }
    }
    const oldWords = old.filter(s => /\p{L}/u.test(s)).length, nextWords = next.filter(s => /\p{L}/u.test(s)).length
    const key = original + '\0' + replacement
    if (isCorrectionTerm(original) && isCorrectionTerm(replacement) && original !== replacement
      && oldWords <= 6 && nextWords <= 6 && !seen.has(key)
      && !technicalAt(before, originalAt) && !technicalAt(after, replacementAt)) {
      seen.add(key); result.push({ original, replacement })
    }
    old = []; next = []
  }
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++ }
    else if (i < a.length && (j === b.length || matrix[(i + 1) * width + j] >= matrix[i * width + j + 1])) {
      if (!old.length) oldStart = i
      old.push(a[i++])
    } else {
      if (!next.length) nextStart = j
      next.push(b[j++])
    }
  }
  flush()
  return result.slice(0, 20)
}

/** Passive input observations are less intentional than saving a history edit.
 * Require a small spelling change so general rewrites do not train vocabulary. */
export function extractInputCorrections(before: string, after: string): CorrectionPair[] {
  return extractCorrections(before, after).filter(pair => {
    const a = [...pair.original.toLocaleLowerCase()], b = [...pair.replacement.toLocaleLowerCase()]
    // A passive edit is weaker evidence than an explicit history correction.
    // Require one complete lexical token and a small spelling change; otherwise
    // a two-character content rewrite such as 张伟 → 李雷 would look valid.
    if (pair.original.includes(' ') || pair.replacement.includes(' ')) return false
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1]
      for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)))
      previous = next
    }
    return previous[b.length] <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.25))
  })
}
