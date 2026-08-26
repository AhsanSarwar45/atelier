/** Natural-size chat media, capped in both dimensions so portraits stay compact. */
export const INLINE_MEDIA_BOUNDS = {
  width: 'auto',
  height: 'auto',
  maxWidth: '100%',
  maxHeight: '24rem',
} as const;
