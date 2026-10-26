// OpenAI's model/list is account-specific. An old configured model must not
// become a selectable option merely because thread/start still reports it.
// Custom providers can legitimately use models absent from that catalogue.
export function patchCodexModelCatalog(modelSource, serverSource) {
  const signature = 'currentBaseModelId: string): SessionConfigOption {';
  const condition = 'if (!availableModels.some(model => model.id === currentBaseModelId)) {';
  const call = 'createModelConfigOption(sessionState.availableModels, currentModelId.model)';
  for (const [source, anchor] of [[modelSource, signature], [modelSource, condition], [serverSource, call]]) {
    if (source.split(anchor).length !== 2) {
      throw new Error('Codex model catalogue anchors changed; audit the pinned adapter');
    }
  }
  return {
    model: modelSource.replace(signature, 'currentBaseModelId: string, provider: string | null = null): SessionConfigOption {')
      .replace(condition, 'if (provider && provider !== "openai" && !availableModels.some(model => model.id === currentBaseModelId)) {'),
    server: serverSource.replace(call, 'createModelConfigOption(sessionState.availableModels, currentModelId.model, sessionState.authProvider)'),
  };
}
