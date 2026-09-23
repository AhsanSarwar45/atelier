/** Keep editor operations lossless and store only explicit project differences. */
export function nextEntryName(entries: Record<string, string>): string {
  let index = 1;
  while (Object.hasOwn(entries, `new-${index}`)) index++;
  return `new-${index}`;
}

interface Customizable<C> {
  content: string;
  when: C;
  automatic: boolean;
  parameters: Record<string, string>;
}

export function buildCustomization<C>(draft: Customizable<C>, source: Customizable<C>, disabled = false) {
  return {
    disabled,
    content: draft.content === source.content ? null : draft.content,
    when: JSON.stringify(draft.when) === JSON.stringify(source.when) ? null : draft.when,
    automatic: draft.automatic === source.automatic ? null : draft.automatic,
    parameters: Object.fromEntries(Object.entries(draft.parameters).filter(([key, value]) => source.parameters[key] !== value)),
  };
}
