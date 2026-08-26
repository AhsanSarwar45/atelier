const LEADING_CHATTER = /^(?:(?:hi|hello|hey)[,!.]?\s+|(?:so|okay|ok|well)[,!.]?\s+|(?:can|could|would) you\s+|please\s+|i (?:want|need|would like) (?:you )?to\s+|look at\s+|currently\s+|we (?:currently )?have\s+)+/i;

const SMALL_WORDS = new Set([
  'a', 'all', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'for', 'from', 'has', 'have', 'i', 'in', 'is', 'it', 'its', 'just', 'like',
  'does', 'my', 'not', 'of', 'on', 'or', 'our', 'please', 'that', 'the', 'their',
  'these', 'they', 'this', 'to', 'we', 'with', 'you', 'your',
]);

/** A short subject name while the provider works out its own conversation name. */
export function conversationTitle(prompt: string): string | null {
  const plain = prompt
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_#>[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_CHATTER, '');
  if (!plain) return null;

  const focused = plain.replace(/[.!?,;:]+$/, '');
  const words = (focused.match(/[\p{L}\p{N}][\p{L}\p{N}'’+./-]*/gu) ?? [])
    .map((word) => word.replace(/[.!?,;:]+$/, ''))
    .filter(Boolean);
  const meaningful = words.filter((word) => !SMALL_WORDS.has(word.toLowerCase()));
  const chosen = (meaningful.length >= 3 ? meaningful : words).slice(0, 6);
  if (!chosen.length) return null;
  return chosen.map((word) => {
    if (/[A-Z].*[A-Z]|[a-z][A-Z]/.test(word) || /^[A-Z\d][A-Z\d+./-]*$/.test(word)) return word;
    return word[0]!.toLocaleUpperCase() + word.slice(1).toLocaleLowerCase();
  }).join(' ');
}
