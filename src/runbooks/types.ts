export type RunbookSource = 'built-in' | 'fleet' | 'external';

export interface RunbookVariant {
  id: string;
  version: string;
}

export interface RunbookTopicManifest {
  id: string;
  title: string;
  summary: string;
  path: string;
}

export interface RunbookResourceManifest {
  id: string;
  title: string;
  mediaType: 'text/markdown' | 'application/yaml' | 'application/json' | 'text/plain';
  path: string;
}

export interface RunbookManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  summary: string;
  license?: string;
  repository?: string;
  variantOf?: RunbookVariant;
  delta?: string;
  requires: { conductor: string };
  topics: RunbookTopicManifest[];
  resources: RunbookResourceManifest[];
}

export interface ResolvedRunbookTopic extends RunbookTopicManifest {
  absolutePath: string;
}

export interface ResolvedRunbookResource extends RunbookResourceManifest {
  absolutePath: string;
}

export interface ResolvedRunbook extends Omit<RunbookManifest, 'topics' | 'resources'> {
  source: RunbookSource;
  rootDir: string;
  manifestPath: string;
  topics: ResolvedRunbookTopic[];
  resources: ResolvedRunbookResource[];
}

export interface RunbookDiagnostic {
  source: RunbookSource;
  path: string;
  message: string;
}

export interface RunbookRegistrySnapshot {
  runbooks: ResolvedRunbook[];
  diagnostics: RunbookDiagnostic[];
}
